import "../infra/fs-safe-defaults.js";
type LockFilePayload = {
    pid?: number;
    createdAt?: string;
    /** Process start time in clock ticks (from /proc/pid/stat field 22). */
    starttime?: number;
    maxHoldMs?: number;
};
export type SessionLockInspection = {
    lockPath: string;
    pid: number | null;
    pidAlive: boolean;
    createdAt: string | null;
    ageMs: number | null;
    stale: boolean;
    staleReasons: string[];
    removed: boolean;
};
export type SessionLockOwnerProcessArgsReader = (pid: number) => string[] | null;
declare const CLEANUP_SIGNALS: readonly ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"];
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];
export declare const DEFAULT_SESSION_WRITE_LOCK_STALE_MS: number;
export declare const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS: number;
export declare const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60000;
type LockInspectionDetails = Pick<SessionLockInspection, "pid" | "pidAlive" | "createdAt" | "ageMs" | "stale" | "staleReasons">;
export type SessionWriteLockAcquireTimeoutConfig = {
    session?: {
        writeLock?: {
            acquireTimeoutMs?: number;
            staleMs?: number;
            maxHoldMs?: number;
        };
    };
};
export declare function resolveSessionWriteLockAcquireTimeoutMs(config?: SessionWriteLockAcquireTimeoutConfig, env?: NodeJS.ProcessEnv): number;
export declare function resolveSessionWriteLockStaleMs(config?: SessionWriteLockAcquireTimeoutConfig, env?: NodeJS.ProcessEnv): number;
export declare function resolveSessionWriteLockMaxHoldMs(config?: SessionWriteLockAcquireTimeoutConfig, params?: {
    env?: NodeJS.ProcessEnv;
    fallback?: number;
}): number;
export declare function resolveSessionWriteLockOptions(config?: SessionWriteLockAcquireTimeoutConfig, params?: {
    env?: NodeJS.ProcessEnv;
    maxHoldMsFallback?: number;
}): {
    timeoutMs: number;
    staleMs: number;
    maxHoldMs: number;
};
export declare function resolveSessionLockMaxHoldFromTimeout(params: {
    timeoutMs: number;
    graceMs?: number;
    minMs?: number;
}): number;
/**
 * Synchronously release all held locks.
 * Used during process exit when async operations aren't reliable.
 */
declare function releaseAllLocksSync(): void;
declare function runLockWatchdogCheck(nowMs?: number): Promise<number>;
declare function handleTerminationSignal(signal: CleanupSignal): void;
declare function inspectLockPayload(payload: LockFilePayload | null, staleMs: number, nowMs: number, opts?: {
    respectMaxHold?: boolean;
}): LockInspectionDetails;
export declare function cleanStaleLockFiles(params: {
    sessionsDir: string;
    config?: SessionWriteLockAcquireTimeoutConfig;
    env?: NodeJS.ProcessEnv;
    staleMs?: number;
    removeStale?: boolean;
    nowMs?: number;
    readOwnerProcessArgs?: SessionLockOwnerProcessArgsReader;
    log?: {
        warn?: (message: string) => void;
        info?: (message: string) => void;
    };
}): Promise<{
    locks: SessionLockInspection[];
    cleaned: SessionLockInspection[];
}>;
export declare function acquireSessionWriteLock(params: {
    sessionFile: string;
    timeoutMs?: number;
    staleMs?: number;
    maxHoldMs?: number;
    allowReentrant?: boolean;
}): Promise<{
    release: () => Promise<void>;
}>;
export declare const testing: {
    cleanupSignals: ("SIGABRT" | "SIGINT" | "SIGQUIT" | "SIGTERM")[];
    handleTerminationSignal: typeof handleTerminationSignal;
    inspectLockPayloadForTest: typeof inspectLockPayload;
    releaseAllLocksSync: typeof releaseAllLocksSync;
    runLockWatchdogCheck: typeof runLockWatchdogCheck;
    setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void;
};
export declare function drainSessionWriteLockStateForTest(): Promise<void>;
export declare function resetSessionWriteLockStateForTest(): void;
export { testing as __testing };
