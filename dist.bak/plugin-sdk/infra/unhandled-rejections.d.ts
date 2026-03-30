type UnhandledRejectionHandler = (reason: unknown) => boolean;
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
export declare function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void;
export declare function isUnhandledRejectionHandled(reason: unknown): boolean;
export declare function installUnhandledRejectionHandler(): void;
export {};
