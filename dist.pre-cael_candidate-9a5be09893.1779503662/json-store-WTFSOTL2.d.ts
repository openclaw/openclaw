import { g as writeJsonSync } from "./json-files-DHg8goTl.js";

//#region src/plugin-sdk/json-store.d.ts
/** Read small JSON blobs synchronously for token/state caches. */
declare function loadJsonFile<T = unknown>(filePath: string): T | undefined;
/** Persist small JSON blobs synchronously with restrictive permissions. */
declare const saveJsonFile: typeof writeJsonSync;
/** Read JSON from disk and fall back cleanly when the file is missing or invalid. */
declare function readJsonFileWithFallback<T>(filePath: string, fallback: T): Promise<{
  value: T;
  exists: boolean;
}>;
/** Write JSON with secure file permissions and atomic replacement semantics. */
declare function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void>;
//#endregion
export { writeJsonFileAtomically as i, readJsonFileWithFallback as n, saveJsonFile as r, loadJsonFile as t };