export declare function readJsonFile<T>(filePath: string): Promise<T | null>;
export declare function writeJsonAtomic(filePath: string, value: unknown, options?: {
    mode?: number;
    trailingNewline?: boolean;
    ensureDirMode?: number;
}): Promise<void>;
export declare function writeTextAtomic(filePath: string, content: string, options?: {
    mode?: number;
    ensureDirMode?: number;
    appendTrailingNewline?: boolean;
}): Promise<void>;
export declare function createAsyncLock(): <T>(fn: () => Promise<T>) => Promise<T>;
