//#region src/logging/levels.d.ts
declare const ALLOWED_LOG_LEVELS: readonly ["silent", "fatal", "error", "warn", "info", "debug", "trace"];
type LogLevel = (typeof ALLOWED_LOG_LEVELS)[number];
declare function normalizeLogLevel(level?: string, fallback?: LogLevel): "error" | "silent" | "info" | "warn" | "trace" | "fatal" | "debug";
declare function levelToMinLevel(level: LogLevel): number;
//#endregion
export { normalizeLogLevel as i, LogLevel as n, levelToMinLevel as r, ALLOWED_LOG_LEVELS as t };