export type BundledPluginLoadPathAliasKind = "current" | "legacy";
export type BundledPluginLoadPathAlias = {
    kind: BundledPluginLoadPathAliasKind;
    path: string;
};
export declare function normalizeBundledLookupPath(targetPath: string): string;
export declare function buildLegacyBundledPath(localPath: string): string | null;
export declare function buildLegacyBundledRootPath(localPath: string): string | null;
export declare function buildBundledPluginLoadPathAliases(localPath: string): BundledPluginLoadPathAlias[];
export declare function resolvePackagedBundledLoadPathAlias(params: {
    bundledRoot?: string;
    loadPath: string;
}): BundledPluginLoadPathAlias | null;
