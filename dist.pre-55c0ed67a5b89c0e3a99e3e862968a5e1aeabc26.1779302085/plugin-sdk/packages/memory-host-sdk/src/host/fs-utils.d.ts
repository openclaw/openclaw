export { root } from "@openclaw/fs-safe/root";
export { isPathInside, isPathInsideWithRealpath } from "@openclaw/fs-safe/path";
export { assertNoSymlinkParents, readRegularFile, statRegularFile, type RegularFileStatResult, } from "@openclaw/fs-safe/advanced";
export { walkDirectory, type WalkDirectoryEntry } from "@openclaw/fs-safe/walk";
export declare function isFileMissingError(err: unknown): err is NodeJS.ErrnoException & {
    code: "ENOENT" | "ENOTDIR" | "not-found";
};
