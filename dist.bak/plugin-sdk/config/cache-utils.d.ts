export declare function resolveCacheTtlMs(params: {
    envValue: string | undefined;
    defaultTtlMs: number;
}): number;
export declare function isCacheEnabled(ttlMs: number): boolean;
export declare function getFileMtimeMs(filePath: string): number | undefined;
