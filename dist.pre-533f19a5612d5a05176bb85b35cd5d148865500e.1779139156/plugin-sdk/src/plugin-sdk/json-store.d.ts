import "../infra/fs-safe-defaults.js";
import { writeJsonSync } from "../infra/json-files.js";
/** Read small JSON blobs synchronously for token/state caches. */
export declare function loadJsonFile<T = unknown>(filePath: string): T | undefined;
/** Persist small JSON blobs synchronously with restrictive permissions. */
export declare const saveJsonFile: typeof writeJsonSync;
/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
export declare function readJsonFileWithFallback<T>(filePath: string, fallback: T): Promise<{
    value: T;
    exists: boolean;
}>;
/** Write JSON with secure file permissions and atomic replacement semantics. */
export declare function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void>;
