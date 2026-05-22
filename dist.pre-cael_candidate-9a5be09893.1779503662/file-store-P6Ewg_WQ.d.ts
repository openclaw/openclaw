import { a as RootReadOptions, i as Root, n as OpenResult, r as ReadResult } from "./root-impl-C9ixeKx2.js";
import { Readable } from "node:stream";

//#region node_modules/@openclaw/fs-safe/dist/sidecar-lock.d.ts
type SidecarLockRetryOptions = {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  randomize?: boolean;
};
type SidecarLockStaleRecovery = "fail-closed" | "remove-if-unchanged";
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/file-store-prune.d.ts
type FileStorePruneOptions = {
  ttlMs: number;
  recursive?: boolean;
  maxDepth?: number;
  pruneEmptyDirs?: boolean;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/file-lock.d.ts
type FileLockRetryOptions = SidecarLockRetryOptions;
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/json-document-store.d.ts
type JsonStoreLockOptions = {
  staleMs?: number;
  timeoutMs?: number;
  retry?: FileLockRetryOptions;
  staleRecovery?: SidecarLockStaleRecovery;
  managerKey?: string;
};
type JsonFileStoreOptions = {
  trailingNewline?: boolean;
  lock?: boolean | JsonStoreLockOptions;
};
type JsonStore<T> = {
  readonly filePath: string;
  read(): Promise<T | undefined>;
  readOr(fallback: T): Promise<T>;
  readRequired(): Promise<T>;
  write(value: T): Promise<void>;
  update(run: (current: T | undefined) => T | Promise<T>): Promise<T>;
  updateOr(fallback: T, run: (current: T) => T | Promise<T>): Promise<T>;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/file-store.d.ts
type FileStoreWriteOptions = {
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
  tempPrefix?: string;
};
type FileStoreReadOptions = RootReadOptions & {
  encoding?: BufferEncoding;
};
type FileStore = {
  readonly rootDir: string;
  path(relativePath: string): string;
  root(): Promise<Root>;
  write(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): Promise<string>;
  writeStream(relativePath: string, stream: Readable, options?: FileStoreWriteOptions): Promise<string>;
  copyIn(relativePath: string, sourcePath: string, options?: FileStoreWriteOptions): Promise<string>;
  open(relativePath: string, options?: RootReadOptions): Promise<OpenResult>;
  read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
  readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
  readText(relativePath: string, options?: FileStoreReadOptions): Promise<string>;
  readTextIfExists(relativePath: string, options?: FileStoreReadOptions): Promise<string | null>;
  readJson<T = unknown>(relativePath: string, options?: FileStoreReadOptions): Promise<T>;
  readJsonIfExists<T = unknown>(relativePath: string, options?: FileStoreReadOptions): Promise<T | null>;
  remove(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  writeText(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): Promise<string>;
  writeJson(relativePath: string, data: unknown, options?: FileStoreWriteOptions & {
    trailingNewline?: boolean;
  }): Promise<string>;
  json<T = unknown>(relativePath: string, options?: JsonFileStoreOptions): JsonStore<T>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};
type FileStoreSync = {
  readonly rootDir: string;
  path(relativePath: string): string;
  readTextIfExists(relativePath: string, options?: {
    maxBytes?: number;
  }): string | null;
  readJsonIfExists<T = unknown>(relativePath: string, options?: {
    maxBytes?: number;
  }): T | null;
  write(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
  writeText(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
  writeJson(relativePath: string, data: unknown, options?: FileStoreWriteOptions & {
    trailingNewline?: boolean;
  }): string;
};
//#endregion
export { FileStoreSync as n, FileStore as t };