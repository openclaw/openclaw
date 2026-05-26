export type BundledPluginSource = {
    pluginId: string;
    localPath: string;
    npmSpec?: string;
    version?: string;
    configSchema?: Record<string, unknown>;
    requiresConfig?: boolean;
};
export type BundledPluginLookup = {
    kind: "npmSpec";
    value: string;
} | {
    kind: "pluginId";
    value: string;
};
export declare function findBundledPluginSourceInMap(params: {
    bundled: ReadonlyMap<string, BundledPluginSource>;
    lookup: BundledPluginLookup;
}): BundledPluginSource | undefined;
export declare function resolveBundledPluginSources(params: {
    workspaceDir?: string;
    /** Use an explicit env when bundled roots should resolve independently from process.env. */
    env?: NodeJS.ProcessEnv;
}): Map<string, BundledPluginSource>;
export declare function findBundledPluginSource(params: {
    lookup: BundledPluginLookup;
    workspaceDir?: string;
    /** Use an explicit env when bundled roots should resolve independently from process.env. */
    env?: NodeJS.ProcessEnv;
}): BundledPluginSource | undefined;
export declare function resolveBundledPluginInstallCommandHint(params: {
    pluginId: string;
    workspaceDir?: string;
    /** Use an explicit env when bundled roots should resolve independently from process.env. */
    env?: NodeJS.ProcessEnv;
}): string | null;
