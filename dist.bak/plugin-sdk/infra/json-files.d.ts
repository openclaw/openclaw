export declare function readJsonFile<T>(filePath: string): Promise<T | null>;
export declare function writeJsonAtomic(filePath: string, value: unknown, options?: {
    mode?: number;
}): Promise<void>;
export declare function createAsyncLock(): <T>(fn: () => Promise<T>) => Promise<T>;
