// Copyright (c) 2020, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import path from 'path';

import _ from 'underscore';

import {splitArguments} from '../../shared/common-utils.js';
import {Arch, CacheKey, ExecutionOptionsWithEnv} from '../../types/compilation/compilation.interfaces.js';
import {CompilerInfo} from '../../types/compiler.interfaces.js';
import {UnprocessedExecResult} from '../../types/execution/execution.interfaces.js';
import {CompilationEnvironment} from '../compilation-env.js';
import {logger} from '../logger.js';
import {VersionInfo} from '../options-handler.js';
import * as utils from '../utils.js';

import type {BuildEnvDownloadInfo} from './buildenv.interfaces.js';

export type ExecCompilerCachedFunc = (
    compiler: string,
    args: string[],
    options?: ExecutionOptionsWithEnv,
) => Promise<UnprocessedExecResult>;

export class BuildEnvSetupBase {
    protected compiler: any;
    protected env: any;
    protected compilerOptionsArr: string[];
    public compilerArch: string | false;
    protected compilerTypeOrGCC: any;
    public compilerSupportsX86: boolean;
    public defaultLibCxx: string;

    constructor(compilerInfo: CompilerInfo, env: CompilationEnvironment) {
        this.compiler = compilerInfo;
        this.env = env;

        this.compilerOptionsArr = splitArguments(this.compiler.options);
        this.compilerArch = this.getCompilerArch();
        this.compilerTypeOrGCC = compilerInfo.compilerType || 'gcc';
        if (this.compilerTypeOrGCC === 'clang-intel') this.compilerTypeOrGCC = 'gcc';
        this.compilerSupportsX86 = !this.compilerArch;
        this.defaultLibCxx = 'libstdc++';
    }

    async initialise(execCompilerCachedFunc: ExecCompilerCachedFunc) {
        if (this.compilerArch) return;
        await this.hasSupportForArch(execCompilerCachedFunc, 'x86')
            .then(res => (this.compilerSupportsX86 = res))
            .catch(error => {
                // Log & keep going, we assume x86 is supported
                logger.error('Could not check for x86 arch support', error);
            });
    }

    async hasSupportForArch(execCompilerCached: ExecCompilerCachedFunc, arch: Arch): Promise<boolean> {
        let result: any;
        let searchFor = arch as string;
        if (this.compiler.exe.includes('icpx')) {
            return arch === 'x86' || arch === 'x86_64';
        } else if (this.compiler.exe.includes('circle')) {
            return arch === 'x86' || arch === 'x86_64';
        } else if (this.compiler.group === 'icc') {
            result = await execCompilerCached(this.compiler.exe, ['--help']);
            if (arch === 'x86') {
                searchFor = '-m32';
            } else if (arch === 'x86_64') {
                searchFor = '-m64';
            }
        } else if (this.compilerTypeOrGCC === 'gcc') {
            if (this.compiler.exe.includes('/icpx')) {
                return arch === 'x86' || arch === 'x86_64';
            } else {
                result = await execCompilerCached(this.compiler.exe, ['--target-help']);
            }
        } else if (this.compilerTypeOrGCC === 'clang') {
            const binpath = path.dirname(this.compiler.exe);
            const llc = path.join(binpath, 'llc');
            if (await utils.fileExists(llc)) {
                result = await execCompilerCached(llc, ['--version']);
            }
        }

        if (result) {
            return result.stdout ? result.stdout.includes(searchFor) : false;
        }

        return false;
    }

    async setup(
        key: CacheKey,
        dirPath: string,
        selectedLibraries: Record<string, VersionInfo>,
        binary: boolean,
    ): Promise<BuildEnvDownloadInfo[]> {
        return [];
    }

    getCompilerArch(): string | false {
        let arch = _.find(this.compilerOptionsArr, option => {
            return option.startsWith('-march=');
        });

        let target = _.find(this.compilerOptionsArr, option => {
            return option.startsWith('-target=') || option.startsWith('--target=');
        });

        if (target) {
            target = target.substring(target.indexOf('=') + 1);
        } else {
            const targetIdx = this.compilerOptionsArr.indexOf('-target');
            if (targetIdx !== -1) {
                target = this.compilerOptionsArr[targetIdx + 1];
            }
        }

        if (arch) {
            arch = arch.substring(7);
        }

        if (target && arch) {
            if (arch.length < target.length) {
                return arch;
            } else {
                return target;
            }
        } else {
            if (target) return target;
            if (arch) return arch;
        }

        return false;
    }

    getLibcxx(key: CacheKey): string {
        const match = this.compiler.options.match(/-stdlib=(\S*)/i);
        if (match) {
            return match[1];
        } else {
            const stdlibOption: string | undefined = _.find(key.options, option => {
                return option.startsWith('-stdlib=');
            });

            if (stdlibOption) {
                return stdlibOption.substring(8);
            }

            return this.defaultLibCxx;
        }
    }

    getTarget(key: CacheKey): string {
        if (!this.compilerSupportsX86) return '';
        if (this.compilerArch) return this.compilerArch;

        if (key.options.includes('-m32')) {
            return 'x86';
        } else {
            const target: string | undefined = _.find(key.options, option => {
                return option.startsWith('-target=') || option.startsWith('--target=');
            });

            if (target) {
                return target.substring(target.indexOf('=') + 1);
            }
        }

        return 'x86_64';
    }

    hasBinariesToLink(details: VersionInfo) {
        return (
            details.libpath.length === 0 &&
            (details.staticliblink.length > 0 || details.liblink.length > 0) &&
            details.version !== 'autodetect'
        );
    }

    hasPackagedHeaders(details: VersionInfo) {
        return !!details.packagedheaders;
    }

    shouldDownloadPackage(details: VersionInfo) {
        return this.hasPackagedHeaders(details) || this.hasBinariesToLink(details);
    }
}
