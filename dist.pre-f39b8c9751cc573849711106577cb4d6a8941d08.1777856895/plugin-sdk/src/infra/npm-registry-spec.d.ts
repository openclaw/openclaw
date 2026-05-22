export type ParsedRegistryNpmSpec = {
    name: string;
    raw: string;
    selector?: string;
    selectorKind: "none" | "exact-version" | "tag";
    selectorIsPrerelease: boolean;
};
export declare function parseRegistryNpmSpec(rawSpec: string): ParsedRegistryNpmSpec | null;
export declare function validateRegistryNpmSpec(rawSpec: string): string | null;
export declare function isExactSemverVersion(value: string): boolean;
export declare function isPrereleaseSemverVersion(value: string): boolean;
export declare function isPrereleaseResolutionAllowed(params: {
    spec: ParsedRegistryNpmSpec;
    resolvedVersion?: string;
}): boolean;
export declare function formatPrereleaseResolutionError(params: {
    spec: ParsedRegistryNpmSpec;
    resolvedVersion: string;
}): string;
