export declare function resolveCacheTtlMs(params: {
    envValue: string | undefined;
    defaultTtlMs: number;
}): number;
export declare function isCacheEnabled(ttlMs: number): boolean;
export type FileStatSnapshot = {
    mtimeMs: number;
    sizeBytes: number;
};
export declare function getFileStatSnapshot(filePath: string): FileStatSnapshot | undefined;
