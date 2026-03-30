import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
export type SafeOpenErrorCode = "invalid-path" | "not-found" | "outside-workspace" | "symlink" | "not-file" | "path-mismatch" | "too-large";
export declare class SafeOpenError extends Error {
    code: SafeOpenErrorCode;
    constructor(code: SafeOpenErrorCode, message: string, options?: ErrorOptions);
}
export type SafeOpenResult = {
    handle: FileHandle;
    realPath: string;
    stat: Stats;
};
export type SafeLocalReadResult = {
    buffer: Buffer;
    realPath: string;
    stat: Stats;
};
export declare function openFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    rejectHardlinks?: boolean;
}): Promise<SafeOpenResult>;
export declare function readLocalFileSafely(params: {
    filePath: string;
    maxBytes?: number;
}): Promise<SafeLocalReadResult>;
export declare function writeFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
}): Promise<void>;
