/**
 * Runner abort check. Catches any abort-related message for embedded runners.
 * More permissive than the core isAbortError since runners need to catch
 * various abort signals from different sources.
 */
export declare function isRunnerAbortError(err: unknown): boolean;
