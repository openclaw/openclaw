export type NpmProjectInstallEnvOptions = {
    cacheDir?: string;
};
export declare function createNpmProjectInstallEnv(env: NodeJS.ProcessEnv, options?: NpmProjectInstallEnvOptions): NodeJS.ProcessEnv;
export declare function hasNpmScriptShellSetting(env: NodeJS.ProcessEnv): boolean;
export declare function resolvePosixNpmScriptShell(env: NodeJS.ProcessEnv): string | null;
export declare function applyPosixNpmScriptShellEnv(env: NodeJS.ProcessEnv): void;
