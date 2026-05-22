//#region src/infra/backoff.d.ts
type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};
declare function computeBackoff(policy: BackoffPolicy, attempt: number): number;
declare function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void>;
//#endregion
//#region src/infra/format-time/format-duration.d.ts
type FormatDurationSecondsOptions = {
  decimals?: number;
  unit?: "s" | "seconds";
};
type FormatDurationCompactOptions = {
  /** Add space between units: "2m 5s" instead of "2m5s". Default: false */spaced?: boolean;
};
declare function formatDurationSeconds(ms: number, options?: FormatDurationSecondsOptions): string;
/** Precise decimal-seconds output: "500ms" or "1.23s". Input is milliseconds. */
declare function formatDurationPrecise(ms: number, options?: FormatDurationSecondsOptions): string;
/**
 * Compact compound duration: "500ms", "45s", "2m5s", "1h30m".
 * With `spaced`: "45s", "2m 5s", "1h 30m".
 * Omits trailing zero components: "1m" not "1m 0s", "2h" not "2h 0m".
 * Returns undefined for null/undefined/non-finite/non-positive input.
 */
declare function formatDurationCompact(ms?: number | null, options?: FormatDurationCompactOptions): string | undefined;
/**
 * Rounded single-unit duration for display: "500ms", "5s", "3m", "2h", "5d".
 * Returns fallback string for null/undefined/non-finite input.
 */
declare function formatDurationHuman(ms?: number | null, fallback?: string): string;
//#endregion
//#region src/infra/net/undici-global-dispatcher.d.ts
declare const DEFAULT_UNDICI_STREAM_TIMEOUT_MS: number;
/**
 * Module-level bridge so `resolveDispatcherTimeoutMs` in fetch-guard.ts
 * can read the global dispatcher timeout without relying on Undici's
 * non-public `.options` field.
 */
declare let globalUndiciStreamTimeoutMs: number | undefined;
declare function ensureGlobalUndiciEnvProxyDispatcher(): void;
declare function ensureGlobalUndiciStreamTimeouts(opts?: {
  timeoutMs?: number;
}): void;
declare function ensureGlobalUndiciDispatcherStreamTimeouts(opts?: {
  timeoutMs?: number;
}): void;
declare function resetGlobalUndiciStreamTimeoutsForTests(): void;
/**
 * Re-evaluate proxy env changes for root undici imports. Installs
 * EnvHttpProxyAgent when proxy env is present, and restores a direct Agent
 * after proxy env is cleared.
 */
declare function forceResetGlobalDispatcher(opts?: {
  preserveProxylineManaged?: boolean;
}): void;
//#endregion
//#region src/infra/wsl.d.ts
declare function resetWSLStateForTests(): void;
declare function isWSLEnv(): boolean;
/**
 * Synchronously check if running in WSL.
 * Checks env vars first, then /proc/version.
 */
declare function isWSLSync(): boolean;
/**
 * Synchronously check if running in WSL2.
 */
declare function isWSL2Sync(): boolean;
declare function isWSL(): Promise<boolean>;
//#endregion
export { formatDurationPrecise as _, resetWSLStateForTests as a, computeBackoff as b, ensureGlobalUndiciEnvProxyDispatcher as c, globalUndiciStreamTimeoutMs as d, resetGlobalUndiciStreamTimeoutsForTests as f, formatDurationHuman as g, formatDurationCompact as h, isWSLSync as i, ensureGlobalUndiciStreamTimeouts as l, FormatDurationSecondsOptions as m, isWSL2Sync as n, DEFAULT_UNDICI_STREAM_TIMEOUT_MS as o, FormatDurationCompactOptions as p, isWSLEnv as r, ensureGlobalUndiciDispatcherStreamTimeouts as s, isWSL as t, forceResetGlobalDispatcher as u, formatDurationSeconds as v, sleepWithAbort as x, BackoffPolicy as y };