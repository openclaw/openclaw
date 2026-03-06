export declare function buildRandomTempFilePath(params: {
    prefix: string;
    extension?: string;
    tmpDir?: string;
    now?: number;
    uuid?: string;
}): string;
export declare function withTempDownloadPath<T>(params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
}, fn: (tmpPath: string) => Promise<T>): Promise<T>;
