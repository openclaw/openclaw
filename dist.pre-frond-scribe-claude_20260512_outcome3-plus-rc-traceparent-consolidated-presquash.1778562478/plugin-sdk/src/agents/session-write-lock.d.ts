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
declare const CLEANUP_SIGNALS: readonly ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"];
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];
export declare const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60000;
export type SessionWriteLockAcquireTimeoutConfig = {
    session?: {
        writeLock?: {
            acquireTimeoutMs?: number;
        };
    };
};
export declare function resolveSessionWriteLockAcquireTimeoutMs(config?: SessionWriteLockAcquireTimeoutConfig): number;
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
export declare function cleanStaleLockFiles(params: {
    sessionsDir: string;
    staleMs?: number;
    removeStale?: boolean;
    nowMs?: number;
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
export declare const __testing: {
    cleanupSignals: ("SIGABRT" | "SIGINT" | "SIGQUIT" | "SIGTERM")[];
    handleTerminationSignal: typeof handleTerminationSignal;
    releaseAllLocksSync: typeof releaseAllLocksSync;
    runLockWatchdogCheck: typeof runLockWatchdogCheck;
};
export declare function drainSessionWriteLockStateForTest(): Promise<void>;
export declare function resetSessionWriteLockStateForTest(): void;
export {};
