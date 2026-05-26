//#region src/shared/regexp.d.ts
declare function escapeRegExp(value: string): string;
//#endregion
//#region src/utils.d.ts
declare function ensureDir(dir: string): Promise<void>;
declare function clampNumber(value: number, min: number, max: number): number;
declare function clampInt(value: number, min: number, max: number): number;
/** Alias for clampNumber (shorter, more common name) */
declare const clamp: typeof clampNumber;
/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
declare function safeParseJson<T>(raw: string): T | null;
/**
 * Type guard for Record<string, unknown> (less strict than isPlainObject).
 * Accepts any non-null object that isn't an array.
 */
declare function isRecord(value: unknown): value is Record<string, unknown>;
declare function normalizeE164(number: string): string;
declare function sleep(ms: number): Promise<unknown>;
declare function sliceUtf16Safe(input: string, start: number, end?: number): string;
declare function truncateUtf16Safe(input: string, maxLen: number): string;
declare function resolveUserPath(input: string, env?: NodeJS.ProcessEnv, homedir?: () => string): string;
declare function resolveConfigDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
declare function resolveHomeDir(): string | undefined;
declare function shortenHomePath(input: string): string;
declare function shortenHomeInString(input: string): string;
declare function displayPath(input: string): string;
declare function displayString(input: string): string;
declare const CONFIG_DIR: string;
/**
 * Check if a file or directory exists at the given path.
 */
declare function pathExists(targetPath: string): Promise<boolean>;
//#endregion
export { sleep as _, displayPath as a, escapeRegExp as b, isRecord as c, resolveConfigDir as d, resolveHomeDir as f, shortenHomePath as g, shortenHomeInString as h, clampNumber as i, normalizeE164 as l, safeParseJson as m, clamp as n, displayString as o, resolveUserPath as p, clampInt as r, ensureDir as s, CONFIG_DIR as t, pathExists as u, sliceUtf16Safe as v, truncateUtf16Safe as y };