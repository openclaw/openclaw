//#region src/secrets/shared.d.ts
declare function isNonEmptyString(value: unknown): value is string;
declare function parseEnvValue(raw: string): string;
declare function normalizePositiveInt(value: unknown, fallback: number): number;
declare function parseDotPath(pathname: string): string[];
declare function toDotPath(segments: string[]): string;
declare function ensureDirForFile(filePath: string): void;
declare function writeJsonFileSecure(pathname: string, value: unknown): void;
declare function readTextFileIfExists(pathname: string): string | null;
declare function writeTextFileAtomic(pathname: string, value: string, mode?: number): void;
//#endregion
export { parseEnvValue as a, writeJsonFileSecure as c, parseDotPath as i, writeTextFileAtomic as l, isNonEmptyString as n, readTextFileIfExists as o, normalizePositiveInt as r, toDotPath as s, ensureDirForFile as t };