export type InstalledPluginIndexStoreOptions = {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    filePath?: string;
};
export declare function resolveInstalledPluginIndexStorePath(options?: InstalledPluginIndexStoreOptions): string;
