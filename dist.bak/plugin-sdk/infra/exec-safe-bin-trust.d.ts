type TrustedSafeBinDirsParams = {
    baseDirs?: readonly string[];
    extraDirs?: readonly string[];
};
type TrustedSafeBinPathParams = {
    resolvedPath: string;
    trustedDirs?: ReadonlySet<string>;
};
export type WritableTrustedSafeBinDir = {
    dir: string;
    groupWritable: boolean;
    worldWritable: boolean;
};
export declare function normalizeTrustedSafeBinDirs(entries?: readonly string[] | null): string[];
export declare function buildTrustedSafeBinDirs(params?: TrustedSafeBinDirsParams): Set<string>;
export declare function getTrustedSafeBinDirs(params?: {
    baseDirs?: readonly string[];
    extraDirs?: readonly string[];
    refresh?: boolean;
}): Set<string>;
export declare function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): boolean;
export declare function listWritableExplicitTrustedSafeBinDirs(entries?: readonly string[] | null): WritableTrustedSafeBinDir[];
export {};
