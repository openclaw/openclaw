export type BoundaryPathIntent = "read" | "write" | "create" | "delete" | "stat";
export type BoundaryPathAliasPolicy = {
    allowFinalSymlinkForUnlink?: boolean;
    allowFinalHardlinkForUnlink?: boolean;
};
export declare const BOUNDARY_PATH_ALIAS_POLICIES: {
    readonly strict: Readonly<{
        allowFinalSymlinkForUnlink: false;
        allowFinalHardlinkForUnlink: false;
    }>;
    readonly unlinkTarget: Readonly<{
        allowFinalSymlinkForUnlink: true;
        allowFinalHardlinkForUnlink: true;
    }>;
};
export type ResolveBoundaryPathParams = {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
    intent?: BoundaryPathIntent;
    policy?: BoundaryPathAliasPolicy;
    skipLexicalRootCheck?: boolean;
    rootCanonicalPath?: string;
};
export type ResolvedBoundaryPathKind = "missing" | "file" | "directory" | "symlink" | "other";
export type ResolvedBoundaryPath = {
    absolutePath: string;
    canonicalPath: string;
    rootPath: string;
    rootCanonicalPath: string;
    relativePath: string;
    exists: boolean;
    kind: ResolvedBoundaryPathKind;
};
export declare function resolveBoundaryPath(params: ResolveBoundaryPathParams): Promise<ResolvedBoundaryPath>;
export declare function resolveBoundaryPathSync(params: ResolveBoundaryPathParams): ResolvedBoundaryPath;
export declare function resolvePathViaExistingAncestor(targetPath: string): Promise<string>;
export declare function resolvePathViaExistingAncestorSync(targetPath: string): string;
