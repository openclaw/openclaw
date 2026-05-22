import { n as OpenResult } from "./root-impl-C9ixeKx2.js";
import { n as FileStoreSync, t as FileStore } from "./file-store-P6Ewg_WQ.js";
import fs from "node:fs";
import fs$1 from "node:fs/promises";

//#region node_modules/@openclaw/fs-safe/dist/root-paths.d.ts
type InvalidPathResult = {
  ok: false;
  error: string;
};
type ResolvePathsWithinRootParams = {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
};
type ResolvePathsWithinRootResult = {
  ok: true;
  paths: string[];
} | InvalidPathResult;
type PathScopeResolveOptions = {
  defaultName?: string;
};
type PathScopeOptions = {
  label: string;
};
type PathScope = {
  rootDir: string;
  label: string;
  resolve(requestedPath: string, options?: PathScopeResolveOptions): {
    ok: true;
    path: string;
  } | {
    ok: false;
    error: string;
  };
  resolveAll(requestedPaths: string[]): ResolvePathsWithinRootResult;
  existing(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
  files(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
  writable(requestedPath: string, options?: PathScopeResolveOptions): Promise<{
    ok: true;
    path: string;
  } | {
    ok: false;
    error: string;
  }>;
  ensureDir(requestedPath: string, options?: PathScopeResolveOptions & {
    mode?: number;
  }): Promise<{
    ok: true;
    path: string;
  } | {
    ok: false;
    error: string;
  }>;
};
declare function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): {
  ok: true;
  path: string;
} | {
  ok: false;
  error: string;
};
declare function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<{
  ok: true;
  path: string;
} | {
  ok: false;
  error: string;
}>;
declare function resolvePathsWithinRoot(params: ResolvePathsWithinRootParams): ResolvePathsWithinRootResult;
declare function resolveExistingPathsWithinRoot(params: ResolvePathsWithinRootParams): Promise<ResolvePathsWithinRootResult>;
declare function resolveStrictExistingPathsWithinRoot(params: ResolvePathsWithinRootParams): Promise<ResolvePathsWithinRootResult>;
declare function pathScope(rootDir: string, options: PathScopeOptions): PathScope;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/symlink-parents.d.ts
type AssertNoSymlinkParentsOptions = {
  rootDir: string;
  targetPath: string;
  allowMissing?: boolean;
  allowOutsideRoot?: boolean;
  allowRootChildSymlink?: boolean;
  requireDirectories?: boolean;
  messagePrefix?: string;
};
declare function assertNoSymlinkParents(params: AssertNoSymlinkParentsOptions): Promise<void>;
declare function assertNoSymlinkParentsSync(params: AssertNoSymlinkParentsOptions): void;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/sibling-temp.d.ts
type WriteSiblingTempFileOptions<T> = {
  dir: string;
  writeTemp: (tempPath: string) => Promise<T>;
  resolveFinalPath: (result: T) => string;
  tempPrefix?: string;
  dirMode?: number;
  chmodDir?: boolean;
  mode?: number;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
};
type WriteSiblingTempFileResult<T> = {
  filePath: string;
  result: T;
};
declare function writeSiblingTempFile<T>(options: WriteSiblingTempFileOptions<T>): Promise<WriteSiblingTempFileResult<T>>;
declare function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
  fallbackFileName?: string;
  tempPrefix?: string;
}): Promise<void>;
//#endregion
//#region src/security/channel-metadata.d.ts
declare function buildUntrustedChannelMetadata(params: {
  source: string;
  label: string;
  entries: Array<string | null | undefined>;
  maxChars?: number;
}): string | undefined;
//#endregion
//#region src/security/safe-regex.d.ts
type SafeRegexRejectReason = "empty" | "unsafe-nested-repetition" | "invalid-regex";
type SafeRegexCompileResult = {
  regex: RegExp;
  source: string;
  flags: string;
  reason: null;
} | {
  regex: null;
  source: string;
  flags: string;
  reason: SafeRegexRejectReason;
};
declare function testRegexWithBoundedInput(regex: RegExp, input: string, maxWindow?: number): boolean;
declare function hasNestedRepetition(source: string): boolean;
declare function compileSafeRegexDetailed(source: string, flags?: string): SafeRegexCompileResult;
declare function compileSafeRegex(source: string, flags?: string): RegExp | null;
//#endregion
//#region src/infra/private-file-store.d.ts
type PrivateFileStore = FileStore;
declare function privateFileStore(rootDir: string): FileStore;
type PrivateFileStoreSync = FileStoreSync;
declare function privateFileStoreSync(rootDir: string): PrivateFileStoreSync;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/replace-file.d.ts
type ReplaceFileAtomicFileSystem = {
  promises: Pick<typeof fs$1, "mkdir" | "chmod" | "writeFile" | "rename" | "copyFile" | "unlink" | "rm" | "open" | "stat" | "lstat">;
};
type ReplaceFileAtomicSyncFileSystem = Pick<typeof fs, "mkdirSync" | "chmodSync" | "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync" | "unlinkSync" | "rmSync" | "openSync" | "fsyncSync" | "closeSync" | "statSync" | "lstatSync">;
type ReplaceFileAtomicBaseOptions = {
  filePath: string;
  content: string | Uint8Array;
  dirMode?: number;
  mode?: number;
  preserveExistingMode?: boolean;
  tempPrefix?: string;
  renameMaxRetries?: number;
  renameRetryBaseDelayMs?: number;
  copyFallbackOnPermissionError?: boolean;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
  throwOnCleanupError?: boolean;
};
type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicFileSystem;
  beforeRename?: (params: {
    filePath: string;
    tempPath: string;
  }) => Promise<void>;
};
type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicSyncFileSystem;
  beforeRename?: (params: {
    filePath: string;
    tempPath: string;
  }) => void;
};
type ReplaceFileAtomicResult = {
  method: "rename" | "copy-fallback";
};
declare function replaceFileAtomic$1(options: ReplaceFileAtomicOptions): Promise<ReplaceFileAtomicResult>;
declare function replaceFileAtomicSync(options: ReplaceFileAtomicSyncOptions): ReplaceFileAtomicResult;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/move-path.d.ts
type MovePathWithCopyFallbackOptions$1 = {
  from: string;
  sourceHardlinks?: "allow" | "reject";
  to: string;
};
//#endregion
//#region src/infra/replace-file.d.ts
declare const replaceFileAtomic: typeof replaceFileAtomic$1;
type MovePathWithCopyFallbackOptions = MovePathWithCopyFallbackOptions$1 & {
  sourceHardlinks?: "allow" | "reject";
};
declare function movePathWithCopyFallback(options: MovePathWithCopyFallbackOptions): Promise<void>;
//#endregion
//#region src/security/secret-equal.d.ts
declare function safeEqualSecret(provided: string | undefined | null, expected: string | undefined | null): boolean;
//#endregion
//#region src/plugin-sdk/security-runtime.d.ts
declare function openFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  nonBlockingRead?: boolean;
  allowSymlinkTargetWithinRoot?: boolean;
}): Promise<OpenResult>;
declare function writeFileFromPathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  mkdir?: boolean;
}): Promise<void>;
//#endregion
export { pathScope as A, WriteSiblingTempFileOptions as C, AssertNoSymlinkParentsOptions as D, writeViaSiblingTempPath as E, resolveWritablePathWithinRoot as F, resolvePathWithinRoot as M, resolvePathsWithinRoot as N, assertNoSymlinkParents as O, resolveStrictExistingPathsWithinRoot as P, buildUntrustedChannelMetadata as S, writeSiblingTempFile as T, SafeRegexRejectReason as _, movePathWithCopyFallback as a, hasNestedRepetition as b, ReplaceFileAtomicOptions as c, ReplaceFileAtomicSyncOptions as d, replaceFileAtomicSync as f, SafeRegexCompileResult as g, privateFileStoreSync as h, MovePathWithCopyFallbackOptions as i, resolveExistingPathsWithinRoot as j, assertNoSymlinkParentsSync as k, ReplaceFileAtomicResult as l, privateFileStore as m, writeFileFromPathWithinRoot as n, replaceFileAtomic as o, PrivateFileStore as p, safeEqualSecret as r, ReplaceFileAtomicFileSystem as s, openFileWithinRoot as t, ReplaceFileAtomicSyncFileSystem as u, compileSafeRegex as v, WriteSiblingTempFileResult as w, testRegexWithBoundedInput as x, compileSafeRegexDetailed as y };