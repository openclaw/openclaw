export type SreStatePaths = {
    stateRootDir: string;
    graphDir: string;
    dossiersDir: string;
    indexDir: string;
    plansDir: string;
};
export declare function resolveSreStatePaths(env?: NodeJS.ProcessEnv): SreStatePaths;
export declare function listSreStateDirs(paths?: SreStatePaths): string[];
