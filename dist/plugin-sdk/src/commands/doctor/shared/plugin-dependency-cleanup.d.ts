declare function collectLegacyPluginDependencyTargets(env?: NodeJS.ProcessEnv, options?: {
    packageRoot?: string | null;
}): Promise<string[]>;
export declare function cleanupLegacyPluginDependencyState(params: {
    env?: NodeJS.ProcessEnv;
    packageRoot?: string | null;
}): Promise<{
    changes: string[];
    warnings: string[];
}>;
export declare const __testing: {
    collectLegacyPluginDependencyTargets: typeof collectLegacyPluginDependencyTargets;
};
export {};
