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
export declare function readFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    rejectHardlinks?: boolean;
    maxBytes?: number;
}): Promise<SafeLocalReadResult>;
export declare function readPathWithinRoot(params: {
    rootDir: string;
    filePath: string;
    rejectHardlinks?: boolean;
    maxBytes?: number;
}): Promise<SafeLocalReadResult>;
export declare function createRootScopedReadFile(params: {
    rootDir: string;
    rejectHardlinks?: boolean;
    maxBytes?: number;
}): (filePath: string) => Promise<Buffer>;
export declare function readLocalFileSafely(params: {
    filePath: string;
    maxBytes?: number;
}): Promise<SafeLocalReadResult>;
export type SafeWritableOpenResult = {
    handle: FileHandle;
    createdForWrite: boolean;
    openedRealPath: string;
    openedStat: Stats;
};
export declare function resolveOpenedFileRealPathForHandle(handle: FileHandle, ioPath: string): Promise<string>;
export declare function openWritableFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    mkdir?: boolean;
    mode?: number;
    truncateExisting?: boolean;
}): Promise<SafeWritableOpenResult>;
export declare function writeFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
}): Promise<void>;
export declare function copyFileWithinRoot(params: {
    sourcePath: string;
    rootDir: string;
    relativePath: string;
    maxBytes?: number;
    mkdir?: boolean;
    rejectSourceHardlinks?: boolean;
}): Promise<void>;
export declare function writeFileFromPathWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    sourcePath: string;
    mkdir?: boolean;
}): Promise<void>;
