export type TimeFormatPreference = "auto" | "12" | "24";
export type ResolvedTimeFormat = "12" | "24";
export declare function resolveUserTimezone(configured?: string): string;
export declare function resolveUserTimeFormat(preference?: TimeFormatPreference): ResolvedTimeFormat;
export declare function normalizeTimestamp(raw: unknown): {
    timestampMs: number;
    timestampUtc: string;
} | undefined;
export declare function withNormalizedTimestamp<T extends Record<string, unknown>>(value: T, rawTimestamp: unknown): T & {
    timestampMs?: number;
    timestampUtc?: string;
};
export declare function formatUserTime(date: Date, timeZone: string, format: ResolvedTimeFormat): string | undefined;
