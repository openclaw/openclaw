export type NpmProjectInstallEnvOptions = {
    cacheDir?: string;
};
export declare function createNpmFreshnessBypassArgs(env?: NodeJS.ProcessEnv, now?: Date): string[];
export declare function applyNpmFreshnessBypassEnv(env: NodeJS.ProcessEnv): void;
export declare function createNpmProjectInstallEnv(env: NodeJS.ProcessEnv, options?: NpmProjectInstallEnvOptions): NodeJS.ProcessEnv;
export declare function hasNpmScriptShellSetting(env: NodeJS.ProcessEnv): boolean;
export declare function resolvePosixNpmScriptShell(env: NodeJS.ProcessEnv): string | null;
export declare function applyPosixNpmScriptShellEnv(env: NodeJS.ProcessEnv): void;
