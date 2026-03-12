export declare function readJsonFileWithFallback<T>(filePath: string, fallback: T): Promise<{
    value: T;
    exists: boolean;
}>;
export declare function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void>;
