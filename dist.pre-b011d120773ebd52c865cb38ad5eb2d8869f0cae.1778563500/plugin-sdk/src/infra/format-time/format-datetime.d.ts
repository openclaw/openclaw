/**
 * Centralized date/time formatting utilities.
 *
 * All formatters are timezone-aware, using Intl.DateTimeFormat.
 * Consolidates duplicated formatUtcTimestamp / formatZonedTimestamp / resolveExplicitTimezone
 * that previously lived in envelope.ts and session-updates.ts.
 */
/**
 * Validate an IANA timezone string. Returns the string if valid, undefined otherwise.
 */
export declare function resolveTimezone(value: string): string | undefined;
export type FormatTimestampOptions = {
    /** Include seconds in the output. Default: false */
    displaySeconds?: boolean;
};
export type FormatZonedTimestampOptions = FormatTimestampOptions & {
    /** IANA timezone string (e.g., 'America/New_York'). Default: system timezone */
    timeZone?: string;
};
/**
 * Format a Date as a UTC timestamp string.
 *
 * Without seconds: `2024-01-15T14:30Z`
 * With seconds:    `2024-01-15T14:30:05Z`
 */
export declare function formatUtcTimestamp(date: Date, options?: FormatTimestampOptions): string;
/**
 * Format a Date with timezone display using Intl.DateTimeFormat.
 *
 * Without seconds: `2024-01-15 14:30 EST`
 * With seconds:    `2024-01-15 14:30:05 EST`
 *
 * Returns undefined if Intl formatting fails.
 */
export declare function formatZonedTimestamp(date: Date, options?: FormatZonedTimestampOptions): string | undefined;
