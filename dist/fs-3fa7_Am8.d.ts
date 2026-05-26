import { _ as FsSafeError, v as FsSafeErrorCode } from "./fs-safe-B3FJofSq.js";

//#region node_modules/@openclaw/fs-safe/dist/absolute-path.d.ts
type AbsolutePathSymlinkPolicy = "reject" | "follow";
type ResolvedAbsolutePath = {
  path: string;
  canonicalPath: string;
};
type ResolvedWritableAbsolutePath = ResolvedAbsolutePath & {
  parentDir: string;
  parentExists: boolean;
};
type EnsureAbsoluteDirectoryOptions = {
  scopeLabel?: string;
  mode?: number;
};
type EnsureAbsoluteDirectoryResult = {
  ok: true;
  path: string;
} | {
  ok: false;
  code: FsSafeErrorCode;
  error: FsSafeError;
};
declare function assertAbsolutePathInput(filePath: string): string;
declare function findExistingAncestor(filePath: string): Promise<string | null>;
declare function canonicalPathFromExistingAncestor(filePath: string): Promise<string>;
declare function resolveAbsolutePathForRead(filePath: string, options?: {
  symlinks?: AbsolutePathSymlinkPolicy;
}): Promise<ResolvedAbsolutePath>;
declare function resolveAbsolutePathForWrite(filePath: string, options?: {
  symlinks?: AbsolutePathSymlinkPolicy;
}): Promise<ResolvedWritableAbsolutePath>;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/filename.d.ts
declare function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/fs.d.ts
/**
 * Returns true when `fs.stat()` can stat the path.
 *
 * This follows stat semantics: broken symlinks return false, while symlinks to
 * existing targets return true.
 */
declare function pathExists(filePath: string): Promise<boolean>;
/**
 * Synchronous counterpart to `pathExists()`, with the same `fs.statSync()`
 * semantics.
 */
declare function pathExistsSync(filePath: string): boolean;
//#endregion
export { EnsureAbsoluteDirectoryOptions as a, ResolvedWritableAbsolutePath as c, findExistingAncestor as d, resolveAbsolutePathForRead as f, AbsolutePathSymlinkPolicy as i, assertAbsolutePathInput as l, pathExistsSync as n, EnsureAbsoluteDirectoryResult as o, resolveAbsolutePathForWrite as p, sanitizeUntrustedFileName as r, ResolvedAbsolutePath as s, pathExists as t, canonicalPathFromExistingAncestor as u };