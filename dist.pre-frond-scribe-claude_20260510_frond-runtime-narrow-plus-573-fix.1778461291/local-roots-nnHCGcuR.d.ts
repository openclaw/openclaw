import { o as SymlinkPolicy, r as ReadResult, t as HardlinkPolicy } from "./root-impl-BOYfWBj-.js";
import { v as FsSafeError, y as FsSafeErrorCode } from "./fs-safe-BdQdLx_S.js";

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
//#region node_modules/@openclaw/fs-safe/dist/local-roots.d.ts
type LocalRootsPathResult = {
  path: string;
  root: string;
};
type LocalRootsReadResult = ReadResult & {
  root: string;
};
type LocalRootsInputOptions = {
  filePath: string;
  roots: readonly string[];
  label?: string;
};
type ResolveLocalPathFromRootsSyncOptions = LocalRootsInputOptions & {
  allowMissing?: boolean;
  requireFile?: boolean;
};
type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  nonBlockingRead?: boolean;
  symlinks?: SymlinkPolicy;
};
declare function resolveLocalPathFromRootsSync(options: ResolveLocalPathFromRootsSyncOptions): LocalRootsPathResult | null;
declare function readLocalFileFromRoots(options: ReadLocalFileFromRootsOptions): Promise<LocalRootsReadResult | null>;
//#endregion
export { sanitizeUntrustedFileName as a, EnsureAbsoluteDirectoryResult as c, assertAbsolutePathInput as d, canonicalPathFromExistingAncestor as f, resolveAbsolutePathForWrite as h, pathExistsSync as i, ResolvedAbsolutePath as l, resolveAbsolutePathForRead as m, resolveLocalPathFromRootsSync as n, AbsolutePathSymlinkPolicy as o, findExistingAncestor as p, pathExists as r, EnsureAbsoluteDirectoryOptions as s, readLocalFileFromRoots as t, ResolvedWritableAbsolutePath as u };