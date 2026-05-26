export declare function normalizeStringEntries(list?: ReadonlyArray<unknown>): string[];
export declare function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>): string[];
export declare function normalizeTrimmedStringList(value: unknown): string[];
export declare function normalizeOptionalTrimmedStringList(value: unknown): string[] | undefined;
export declare function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined;
export declare function normalizeSingleOrTrimmedStringList(value: unknown): string[];
export declare function normalizeCsvOrLooseStringList(value: unknown): string[];
export declare function normalizeHyphenSlug(raw?: string | null): string;
export declare function normalizeAtHashSlug(raw?: string | null): string;
