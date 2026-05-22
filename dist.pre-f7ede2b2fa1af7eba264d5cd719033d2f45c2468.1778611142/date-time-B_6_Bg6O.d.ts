//#region src/agents/date-time.d.ts
type TimeFormatPreference = "auto" | "12" | "24";
type ResolvedTimeFormat = "12" | "24";
declare function resolveUserTimezone(configured?: string): string;
declare function resolveUserTimeFormat(preference?: TimeFormatPreference): ResolvedTimeFormat;
declare function normalizeTimestamp(raw: unknown): {
  timestampMs: number;
  timestampUtc: string;
} | undefined;
declare function withNormalizedTimestamp<T extends Record<string, unknown>>(value: T, rawTimestamp: unknown): T & {
  timestampMs?: number;
  timestampUtc?: string;
};
declare function formatUserTime(date: Date, timeZone: string, format: ResolvedTimeFormat): string | undefined;
//#endregion
export { resolveUserTimeFormat as a, normalizeTimestamp as i, TimeFormatPreference as n, resolveUserTimezone as o, formatUserTime as r, withNormalizedTimestamp as s, ResolvedTimeFormat as t };