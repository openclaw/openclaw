export { root } from "@openclaw/fs-safe/root";
export { isPathInside } from "@openclaw/fs-safe/path";
export { readRegularFile, statRegularFile, type RegularFileStatResult, } from "@openclaw/fs-safe/advanced";
export { walkDirectory, type WalkDirectoryEntry } from "@openclaw/fs-safe/walk";
export declare function isFileMissingError(err: unknown): err is NodeJS.ErrnoException & {
    code: "ENOENT";
};
