export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function isNonEmptyString(value: unknown): value is string;
export declare function normalizePositiveInt(value: unknown, fallback: number): number;
export declare function ensureDirForFile(filePath: string): void;
export declare function writeJsonFileSecure(pathname: string, value: unknown): void;
export declare function readTextFileIfExists(pathname: string): string | null;
export declare function writeTextFileAtomic(pathname: string, value: string, mode?: number): void;
