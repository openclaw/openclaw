export type FormatDurationSecondsOptions = {
    decimals?: number;
    unit?: "s" | "seconds";
};
export type FormatDurationCompactOptions = {
    /** Add space between units: "2m 5s" instead of "2m5s". Default: false */
    spaced?: boolean;
};
export declare function formatDurationSeconds(ms: number, options?: FormatDurationSecondsOptions): string;
/** Precise decimal-seconds output: "500ms" or "1.23s". Input is milliseconds. */
export declare function formatDurationPrecise(ms: number, options?: FormatDurationSecondsOptions): string;
/**
 * Compact compound duration: "500ms", "45s", "2m5s", "1h30m".
 * With `spaced`: "45s", "2m 5s", "1h 30m".
 * Omits trailing zero components: "1m" not "1m 0s", "2h" not "2h 0m".
 * Returns undefined for null/undefined/non-finite/non-positive input.
 */
export declare function formatDurationCompact(ms?: number | null, options?: FormatDurationCompactOptions): string | undefined;
/**
 * Rounded single-unit duration for display: "500ms", "5s", "3m", "2h", "5d".
 * Returns fallback string for null/undefined/non-finite input.
 */
export declare function formatDurationHuman(ms?: number | null, fallback?: string): string;
