type UnhandledRejectionHandler = (reason: unknown) => boolean;
type UncaughtExceptionHandler = (error: unknown) => boolean;
/**
 * Checks if an error is an AbortError.
 * These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
 */
export declare function isAbortError(err: unknown): boolean;
/**
 * Checks if an error is a transient network error that shouldn't crash the gateway.
 * These are typically temporary connectivity issues that will resolve on their own.
 */
export declare function isTransientNetworkError(err: unknown): boolean;
export declare function isTransientSqliteError(err: unknown): boolean;
/**
 * Checks if an error is a transient file watcher error that shouldn't crash the gateway.
 * These are typically resource exhaustion issues (e.g., inotify watches exhausted) that
 * can be recovered from by degrading to manual sync mode.
 *
 * Note: ENOSPC is a general POSIX error code (disk full, write failures, etc.).
 * To avoid misclassifying unrelated storage failures, we require both the ENOSPC code
 * AND a watch/inotify-related message indicator, similar to how hasSqliteSignal gates
 * SQLite errors.
 */
export declare function isTransientFileWatchError(err: unknown): boolean;
export declare function isTransientUnhandledRejectionError(err: unknown): boolean;
export declare function isBenignUncaughtExceptionError(err: unknown): boolean;
export declare function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void;
export declare function isUnhandledRejectionHandled(reason: unknown): boolean;
export declare function registerUncaughtExceptionHandler(handler: UncaughtExceptionHandler): () => void;
export declare function isUncaughtExceptionHandled(error: unknown): boolean;
export declare function installUnhandledRejectionHandler(): void;
export {};
