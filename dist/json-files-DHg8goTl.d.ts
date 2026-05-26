import { r as RootFileOpenFailure } from "./root-file-DhFzjJm7.js";
import fs from "node:fs";

//#region node_modules/@openclaw/fs-safe/dist/text-atomic.d.ts
type WriteTextAtomicOptions$1 = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  /**
   * When false, skip the temp-file and parent-directory fsync calls while
   * preserving the temp-file replace/rename behavior.
   *
   * Defaults to true.
   */
  durable?: boolean;
};
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/json.d.ts
declare function tryReadJsonSync<T = unknown>(pathname: string): T | null;
declare function writeJsonSync(pathname: string, data: unknown): void;
declare class JsonFileReadError extends Error {
  readonly filePath: string;
  readonly reason: "read" | "parse";
  constructor(filePath: string, reason: "read" | "parse", cause: unknown);
}
type RootStructuredFileReadResult<T> = {
  ok: true;
  value: T;
  stat: fs.Stats;
  path: string;
  rootRealPath: string;
} | {
  ok: false;
  reason: "open";
  failure: RootFileOpenFailure;
} | {
  ok: false;
  reason: "invalid" | "parse";
  error: string;
};
type ReadRootStructuredFileSyncOptions<T> = {
  rootDir: string;
  rootRealPath?: string;
  relativePath: string;
  boundaryLabel: string;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  parse: (raw: string) => unknown;
  validate?: (value: unknown) => value is T;
  invalidMessage?: string | ((relativePath: string) => string);
};
type ReadRootJsonSyncOptions = Omit<ReadRootStructuredFileSyncOptions<unknown>, "parse" | "validate" | "invalidMessage">;
declare function readRootStructuredFileSync<T>(options: ReadRootStructuredFileSyncOptions<T>): RootStructuredFileReadResult<T>;
declare function readRootJsonSync<T = unknown>(options: ReadRootJsonSyncOptions): RootStructuredFileReadResult<T>;
declare function readRootJsonObjectSync(options: ReadRootJsonSyncOptions): RootStructuredFileReadResult<Record<string, unknown>>;
declare function readJsonSync<T = unknown>(filePath: string): T;
type WriteJsonOptions = Pick<WriteTextAtomicOptions$1, "dirMode" | "durable" | "mode" | "trailingNewline">;
declare function writeJson(filePath: string, value: unknown, options?: WriteJsonOptions): Promise<void>;
//#endregion
//#region src/infra/json-files.d.ts
declare function readJson<T>(filePath: string): Promise<T>;
declare function readJsonFileStrict<T>(filePath: string): Promise<T>;
declare function readJsonIfExists<T>(filePath: string): Promise<T | null>;
declare function readDurableJsonFile<T>(filePath: string): Promise<T | null>;
/**
 * tryReadJson delegates to readJsonIfExists instead of the internal
 * tryReadJsonImpl from @openclaw/fs-safe. The fs-safe implementation
 * swallows all errors internally and returns null, which prevents
 * the retry wrapper from detecting transient "File changed during read"
 * race conditions.
 *
 * By routing through readJsonIfExists, fs-safe propagates errors on
 * race conditions, our retry wrapper intercepts and retries them,
 * and the outer try-catch still handles parse errors / file-not-found
 * gracefully.
 */
declare function tryReadJson<T>(filePath: string): Promise<T | null>;
declare function readJsonFile<T>(filePath: string): Promise<T | null>;
type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  durable?: boolean;
};
declare function writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
//#endregion
export { readJsonFileStrict as a, writeTextAtomic as c, readRootJsonObjectSync as d, readRootJsonSync as f, writeJsonSync as g, writeJson as h, readJsonFile as i, JsonFileReadError as l, tryReadJsonSync as m, readDurableJsonFile as n, readJsonIfExists as o, readRootStructuredFileSync as p, readJson as r, tryReadJson as s, WriteTextAtomicOptions as t, readJsonSync as u };