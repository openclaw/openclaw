/**
 * Centralized relative-time formatting utilities.
 *
 * Consolidates 7+ scattered implementations (formatAge, formatAgeShort, formatAgo,
 * formatRelativeTime, formatElapsedTime) into two functions:
 *
 * - `formatTimeAgo(durationMs)` — format a duration as "5m ago" / "5m" (for known elapsed time)
 * - `formatRelativeTimestamp(epochMs)` — format an epoch timestamp relative to now (handles future)
 */
export type FormatTimeAgoOptions = {
    /** Append "ago" suffix. Default: true. When false, returns bare unit: "5m", "2h" */
    suffix?: boolean;
    /** Return value for invalid/null/negative input. Default: "unknown" */
    fallback?: string;
};
/**
 * Format a duration (in ms) as a human-readable relative time.
 *
 * Input: how many milliseconds ago something happened.
 *
 * With suffix (default):  "just now", "5m ago", "3h ago", "2d ago"
 * Without suffix:         "0s", "5m", "3h", "2d"
 */
export declare function formatTimeAgo(durationMs: number | null | undefined, options?: FormatTimeAgoOptions): string;
export type FormatRelativeTimestampOptions = {
    /** If true, fall back to short date (e.g. "Oct 5") for timestamps >7 days. Default: false */
    dateFallback?: boolean;
    /** IANA timezone for date fallback display */
    timezone?: string;
    /** Return value for invalid/null input. Default: "n/a" */
    fallback?: string;
};
/**
 * Format an epoch timestamp relative to now.
 *
 * Handles both past ("5m ago") and future ("in 5m") timestamps.
 * Optionally falls back to a short date for timestamps older than 7 days.
 */
export declare function formatRelativeTimestamp(timestampMs: number | null | undefined, options?: FormatRelativeTimestampOptions): string;
