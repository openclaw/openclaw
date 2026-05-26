//#region src/shared/string-normalization.d.ts
declare function normalizeStringEntries(list?: ReadonlyArray<unknown>): string[];
declare function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>): string[];
declare function normalizeTrimmedStringList(value: unknown): string[];
declare function normalizeOptionalTrimmedStringList(value: unknown): string[] | undefined;
declare function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined;
declare function normalizeSingleOrTrimmedStringList(value: unknown): string[];
declare function normalizeCsvOrLooseStringList(value: unknown): string[];
declare function normalizeHyphenSlug(raw?: string | null): string;
declare function normalizeAtHashSlug(raw?: string | null): string;
//#endregion
export { normalizeOptionalTrimmedStringList as a, normalizeStringEntriesLower as c, normalizeHyphenSlug as i, normalizeTrimmedStringList as l, normalizeAtHashSlug as n, normalizeSingleOrTrimmedStringList as o, normalizeCsvOrLooseStringList as r, normalizeStringEntries as s, normalizeArrayBackedTrimmedStringList as t };