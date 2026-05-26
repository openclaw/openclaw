export declare const blockedInstallDependencyPackageNames: readonly ["plain-crypto-js"];
export type BlockedManifestDependencyFinding = {
    dependencyName: string;
    declaredAs?: string;
    field: "dependencies" | "name" | "optionalDependencies" | "overrides" | "peerDependencies";
};
export type BlockedPackageDirectoryFinding = {
    dependencyName: string;
    directoryRelativePath: string;
};
export type BlockedPackageFileFinding = {
    dependencyName: string;
    fileRelativePath: string;
};
type PackageDependencyMapFields = Partial<Record<Exclude<BlockedManifestDependencyFinding["field"], "name" | "overrides">, Record<string, string>>>;
type PackageDependencyFields = {
    name?: string;
} & PackageDependencyMapFields;
type PackageOverrideFields = {
    overrides?: unknown;
};
export declare function findBlockedManifestDependencies(manifest: PackageDependencyFields & PackageOverrideFields): BlockedManifestDependencyFinding[];
export declare function findBlockedNodeModulesDirectory(params: {
    directoryRelativePath: string;
}): BlockedPackageDirectoryFinding | undefined;
export declare function findBlockedNodeModulesFileAlias(params: {
    fileRelativePath: string;
}): BlockedPackageFileFinding | undefined;
export declare function findBlockedPackageDirectoryInPath(params: {
    pathRelativeToRoot: string;
}): BlockedPackageDirectoryFinding | undefined;
export declare function findBlockedPackageFileAliasInPath(params: {
    pathRelativeToRoot: string;
}): BlockedPackageFileFinding | undefined;
export {};
