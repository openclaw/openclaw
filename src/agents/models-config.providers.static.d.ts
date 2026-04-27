export type BundledProviderCatalogEntry = {
    dirName: string;
    pluginId: string;
    providers: readonly string[];
    artifactPath: string;
};
type ProviderCatalogModule = Record<string, unknown>;
type ProviderCatalogExportMap = Record<string, unknown>;
export declare function resolveBundledProviderCatalogEntries(params?: {
    rootDir?: string;
}): ReadonlyArray<BundledProviderCatalogEntry>;
export declare function loadBundledProviderCatalogModules(params?: {
    rootDir?: string;
}): Promise<Readonly<Record<string, ProviderCatalogModule>>>;
export declare function loadBundledProviderCatalogExportMap(params?: {
    rootDir?: string;
}): Promise<Readonly<ProviderCatalogExportMap>>;
export {};
