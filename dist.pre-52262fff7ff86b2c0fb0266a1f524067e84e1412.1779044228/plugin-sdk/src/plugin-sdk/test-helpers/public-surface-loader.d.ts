type AsyncBundledPluginPublicSurfaceLoader = <T extends object>(params: {
    pluginId: string;
    artifactBasename: string;
}) => Promise<T>;
type BundledPluginPublicSurfaceLoader = <T extends object>(params: {
    pluginId: string;
    artifactBasename: string;
}) => T;
export declare const loadBundledPluginPublicSurface: AsyncBundledPluginPublicSurfaceLoader;
export declare const loadBundledPluginPublicSurfaceSync: BundledPluginPublicSurfaceLoader;
export declare function resolveWorkspacePackagePublicModuleUrl(params: {
    packageName: string;
    artifactBasename: string;
}): string;
export {};
