import { r as ReadResult } from "./root-impl-C9ixeKx2.js";
import fs, { Stats } from "node:fs";

//#region node_modules/@openclaw/fs-safe/dist/errors.d.ts
type FsSafeErrorCode = "already-exists" | "hardlink" | "helper-failed" | "helper-unavailable" | "invalid-path" | "insecure-permissions" | "not-empty" | "not-file" | "not-found" | "not-owned" | "not-removable" | "outside-workspace" | "path-alias" | "path-mismatch" | "permission-unverified" | "symlink" | "timeout" | "too-large" | "unsupported-platform";
type FsSafeErrorCategory = "policy" | "operational";
declare class FsSafeError extends Error {
  readonly code: FsSafeErrorCode;
  readonly category: FsSafeErrorCategory;
  constructor(code: FsSafeErrorCode, message: string, options?: {
    cause?: unknown;
  });
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/permissions.d.ts
type PermissionExec = (command: string, args: string[]) => Promise<{
  stdout: string;
  stderr: string;
}>;
type PermissionCheck = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "windows-acl" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  aclSummary?: string;
  error?: string;
};
type PermissionCheckOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: PermissionExec;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/path.d.ts
declare function isNotFoundPathError(value: unknown): boolean;
declare function isPathInside(root: string, target: string): boolean;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/secure-file.d.ts
type SecureFileReadOptions = {
  filePath: string;
  label?: string;
  trust?: SecureFileTrustOptions;
  permissions?: SecureFilePermissionOptions;
  inject?: SecureFileInjectOptions;
  io?: SecureFileIoOptions;
};
type SecureFileTrustOptions = {
  trustedDirs?: string[];
  allowSymlink?: boolean;
  allowNetworkPath?: boolean;
};
type SecureFilePermissionOptions = {
  allowInsecure?: boolean;
  allowReadableByOthers?: boolean;
};
type SecureFileInjectOptions = PermissionCheckOptions;
type SecureFileIoOptions = {
  maxBytes?: number;
  timeoutMs?: number;
};
type SecureFileReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
  permissions?: PermissionCheck;
};
declare function readSecureFile(options: SecureFileReadOptions): Promise<SecureFileReadResult>;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/walk.d.ts
type WalkEntryKind = "file" | "directory" | "symlink" | "other";
type WalkSymlinkPolicy = "skip" | "follow" | "include";
type WalkDirectoryEntry = {
  name: string;
  path: string;
  relativePath: string;
  depth: number;
  kind: WalkEntryKind;
  dirent: fs.Dirent;
};
type WalkDirectoryOptions = {
  maxDepth?: number;
  maxEntries?: number;
  symlinks?: WalkSymlinkPolicy;
  include?: (entry: WalkDirectoryEntry) => boolean;
  descend?: (entry: WalkDirectoryEntry) => boolean;
};
type WalkDirectoryResult = {
  entries: WalkDirectoryEntry[];
  scannedEntryCount: number;
  truncated: boolean;
};
declare function walkDirectorySync(rootDir: string, options?: WalkDirectoryOptions): WalkDirectoryResult;
declare function walkDirectory(rootDir: string, options?: WalkDirectoryOptions): Promise<WalkDirectoryResult>;
//#endregion
//#region src/infra/fs-safe.d.ts
type ExternalFileWriteOptions = {
  rootDir: string;
  path: string;
  write: (tempPath: string) => Promise<void>;
  fallbackFileName?: string;
  tempPrefix?: string;
};
type ExternalFileWriteResult = {
  path: string;
};
declare function ensureAbsoluteDirectory(dirPath: string, options?: {
  scopeLabel?: string;
  mode?: number;
}): Promise<{
  ok: true;
  path: string;
} | {
  ok: false;
  error: Error;
}>;
declare function writeExternalFileWithinRoot(options: ExternalFileWriteOptions): Promise<ExternalFileWriteResult>;
/** @deprecated Use root(rootDir).read(relativePath, options). */
declare function readFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  nonBlockingRead?: boolean;
  allowSymlinkTargetWithinRoot?: boolean;
  maxBytes?: number;
}): Promise<ReadResult>;
/** @deprecated Use root(rootDir).write(relativePath, data, options). */
declare function writeFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void>;
//#endregion
export { FsSafeError as _, writeExternalFileWithinRoot as a, WalkDirectoryOptions as c, walkDirectorySync as d, SecureFileReadOptions as f, isPathInside as g, isNotFoundPathError as h, readFileWithinRoot as i, WalkDirectoryResult as l, readSecureFile as m, ExternalFileWriteResult as n, writeFileWithinRoot as o, SecureFileReadResult as p, ensureAbsoluteDirectory as r, WalkDirectoryEntry as s, ExternalFileWriteOptions as t, walkDirectory as u, FsSafeErrorCode as v };