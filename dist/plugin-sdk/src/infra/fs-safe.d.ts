import "./fs-safe-defaults.js";
import { type ReadResult } from "@openclaw/fs-safe/root";
export { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe/errors";
export { assertAbsolutePathInput, canonicalPathFromExistingAncestor, findExistingAncestor, resolveAbsolutePathForRead, resolveAbsolutePathForWrite, type AbsolutePathSymlinkPolicy, type EnsureAbsoluteDirectoryOptions, type EnsureAbsoluteDirectoryResult, type ResolvedAbsolutePath, type ResolvedWritableAbsolutePath, } from "@openclaw/fs-safe/advanced";
export { isPathInside } from "@openclaw/fs-safe/path";
export { pathExists, pathExistsSync } from "@openclaw/fs-safe/advanced";
export { movePathToTrash, type MovePathToTrashOptions } from "@openclaw/fs-safe/advanced";
export { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "@openclaw/fs-safe/advanced";
export { appendRegularFile, appendRegularFileSync, readRegularFile, readRegularFileSync, resolveRegularFileAppendFlags, statRegularFile, statRegularFileSync, } from "@openclaw/fs-safe/advanced";
export { openLocalFileSafely, readLocalFileSafely, resolveOpenedFileRealPathForHandle, root, type OpenResult, type ReadResult, } from "@openclaw/fs-safe/root";
export { sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
export { readSecureFile, type SecureFileReadOptions, type SecureFileReadResult, } from "@openclaw/fs-safe/secure-file";
export { walkDirectory, walkDirectorySync, type WalkDirectoryEntry, type WalkDirectoryOptions, type WalkDirectoryResult, } from "@openclaw/fs-safe/walk";
export { withTimeout } from "@openclaw/fs-safe/advanced";
export type ExternalFileWriteOptions = {
    rootDir: string;
    path: string;
    write: (tempPath: string) => Promise<void>;
    fallbackFileName?: string;
    tempPrefix?: string;
};
export type ExternalFileWriteResult = {
    path: string;
};
export declare function ensureAbsoluteDirectory(dirPath: string, options?: {
    scopeLabel?: string;
    mode?: number;
}): Promise<{
    ok: true;
    path: string;
} | {
    ok: false;
    error: Error;
}>;
export declare function writeExternalFileWithinRoot(options: ExternalFileWriteOptions): Promise<ExternalFileWriteResult>;
/** @deprecated Use root(rootDir).read(relativePath, options). */
export declare function readFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    rejectHardlinks?: boolean;
    nonBlockingRead?: boolean;
    allowSymlinkTargetWithinRoot?: boolean;
    maxBytes?: number;
}): Promise<ReadResult>;
/** @deprecated Use root(rootDir).write(relativePath, data, options). */
export declare function writeFileWithinRoot(params: {
    rootDir: string;
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
}): Promise<void>;
