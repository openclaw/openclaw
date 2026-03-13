export type PluginSourceRoots = {
    stock?: string;
    global: string;
    workspace?: string;
};
export type PluginCacheInputs = {
    roots: PluginSourceRoots;
    loadPaths: string[];
};
export declare function resolvePluginSourceRoots(params: {
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): PluginSourceRoots;
export declare function resolvePluginCacheInputs(params: {
    workspaceDir?: string;
    loadPaths?: string[];
    env?: NodeJS.ProcessEnv;
}): PluginCacheInputs;
