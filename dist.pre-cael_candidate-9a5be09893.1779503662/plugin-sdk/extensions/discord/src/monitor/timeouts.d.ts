export declare const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120000;
export declare const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS: number;
export declare const DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS = 60000;
export declare const DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS = 120000;
export declare function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined;
export declare function raceWithTimeout<T, U>(params: {
    promise: Promise<T>;
    timeoutMs: number;
    onTimeout: () => U;
}): Promise<T | U>;
export declare function withAbortTimeout<T>(params: {
    timeoutMs: number;
    createTimeoutError: () => Error;
    run: (signal: AbortSignal) => Promise<T>;
}): Promise<T>;
