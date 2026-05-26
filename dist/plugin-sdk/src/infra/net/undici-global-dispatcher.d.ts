export declare const DEFAULT_UNDICI_STREAM_TIMEOUT_MS: number;
/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
export declare let globalUndiciStreamTimeoutMs: number | undefined;
export declare function ensureGlobalUndiciEnvProxyDispatcher(): void;
export declare function ensureGlobalUndiciStreamTimeouts(opts?: {
    timeoutMs?: number;
}): void;
export declare function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: {
    timeoutMs?: number;
}): void;
export declare function resetGlobalUndiciStreamTimeoutsForTests(): void;
/**
 * Re-evaluate proxy env changes for root undici imports. Installs
 * EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
 * after proxy env is cleared.
 */
export declare function forceResetGlobalDispatcher(opts?: {
    preserveProxylineManaged?: boolean;
}): void;
