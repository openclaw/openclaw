import "./fs-safe-defaults.js";
export { JsonFileReadError, readJsonSync, readRootJsonObjectSync, readRootJsonSync, readRootStructuredFileSync, tryReadJsonSync, tryReadJsonSync as readJsonFileSync, writeJson, writeJson as writeJsonAtomic, writeJsonSync, } from "@openclaw/fs-safe/json";
export declare function readJson<T>(filePath: string): Promise<T>;
export declare function readJsonFileStrict<T>(filePath: string): Promise<T>;
export declare function readJsonIfExists<T>(filePath: string): Promise<T | null>;
export declare function readDurableJsonFile<T>(filePath: string): Promise<T | null>;
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
export declare function tryReadJson<T>(filePath: string): Promise<T | null>;
export declare function readJsonFile<T>(filePath: string): Promise<T | null>;
export { createAsyncLock } from "@openclaw/fs-safe/advanced";
export type WriteTextAtomicOptions = {
    mode?: number;
    dirMode?: number;
    trailingNewline?: boolean;
    durable?: boolean;
};
export declare function writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void>;
