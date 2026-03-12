export declare function extractErrorCode(err: unknown): string | undefined;
/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export declare function isErrno(err: unknown): err is NodeJS.ErrnoException;
/**
 * Check if an error has a specific errno code.
 */
export declare function hasErrnoCode(err: unknown, code: string): boolean;
export declare function formatErrorMessage(err: unknown): string;
export declare function formatUncaughtError(err: unknown): string;
