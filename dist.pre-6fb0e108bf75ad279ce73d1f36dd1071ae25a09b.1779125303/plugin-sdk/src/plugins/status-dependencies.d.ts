export type PluginDependencySpecMap = Record<string, string>;
export type PluginDependencyEntry = {
    name: string;
    spec: string;
    installed: boolean;
    optional: boolean;
    resolvedPath?: string;
};
export type PluginDependencyStatus = {
    hasDependencies: boolean;
    installed: boolean;
    requiredInstalled: boolean;
    optionalInstalled: boolean;
    missing: string[];
    missingOptional: string[];
    dependencies: PluginDependencyEntry[];
    optionalDependencies: PluginDependencyEntry[];
};
export declare function normalizePluginDependencySpecs(params: {
    dependencies?: unknown;
    optionalDependencies?: unknown;
}): {
    dependencies: PluginDependencySpecMap;
    optionalDependencies: PluginDependencySpecMap;
};
export declare function buildPluginDependencyStatus(params: {
    rootDir?: string;
    dependencies?: PluginDependencySpecMap;
    optionalDependencies?: PluginDependencySpecMap;
}): PluginDependencyStatus;
