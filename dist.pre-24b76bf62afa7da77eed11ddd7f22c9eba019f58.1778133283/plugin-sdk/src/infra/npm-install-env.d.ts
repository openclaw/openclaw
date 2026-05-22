export type NpmProjectInstallEnvOptions = {
    cacheDir?: string;
};
export declare function createNpmProjectInstallEnv(env: NodeJS.ProcessEnv, options?: NpmProjectInstallEnvOptions): NodeJS.ProcessEnv;
