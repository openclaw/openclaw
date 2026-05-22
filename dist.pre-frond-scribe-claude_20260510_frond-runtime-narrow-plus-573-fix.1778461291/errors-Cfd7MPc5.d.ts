//#region src/infra/errors.d.ts
declare function extractErrorCode(err: unknown): string | undefined;
declare function readErrorName(err: unknown): string;
declare function collectErrorGraphCandidates(err: unknown, resolveNested?: (current: Record<string, unknown>) => Iterable<unknown>): unknown[];
/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
declare function isErrno(err: unknown): err is NodeJS.ErrnoException;
/**
 * Check if an error has a specific errno code.
 */
declare function hasErrnoCode(err: unknown, code: string): boolean;
declare function formatErrorMessage(err: unknown): string;
declare function formatUncaughtError(err: unknown): string;
type ErrorKind = "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";
declare function detectErrorKind(err: unknown): ErrorKind | undefined;
//#endregion
export { formatErrorMessage as a, isErrno as c, extractErrorCode as i, readErrorName as l, collectErrorGraphCandidates as n, formatUncaughtError as o, detectErrorKind as r, hasErrnoCode as s, ErrorKind as t };