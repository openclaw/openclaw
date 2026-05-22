export declare function resolveExistingPluginModulePath(rootDir: string, specifier: string): string;
export declare function loadChannelPluginModule(params: {
    modulePath: string;
    rootDir: string;
    boundaryRootDir?: string;
    boundaryLabel?: string;
}): unknown;
