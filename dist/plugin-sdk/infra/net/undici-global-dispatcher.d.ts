export declare const DEFAULT_UNDICI_STREAM_TIMEOUT_MS: number;
export declare function ensureGlobalUndiciEnvProxyDispatcher(): void;
export declare function ensureGlobalUndiciStreamTimeouts(opts?: {
    timeoutMs?: number;
}): void;
export declare function resetGlobalUndiciStreamTimeoutsForTests(): void;
