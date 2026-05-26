export declare function isValidTimeZone(tz: string): boolean;
type TimestampStyle = "short" | "medium" | "long";
type FormatTimestampOptions = {
    style?: TimestampStyle;
    timeZone?: string;
};
export declare function formatTimestamp(date: Date, options?: FormatTimestampOptions): string;
/**
 * @deprecated Use formatTimestamp from "./timestamps.js" instead.
 * This function will be removed in a future version.
 */
export declare function formatLocalIsoWithOffset(now: Date, timeZone?: string): string;
export {};
