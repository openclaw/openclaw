import type { SessionLockInspection } from "./session-write-lock.js";
import "./session-write-lock.js";

type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGQUIT" | "SIGABRT";
type LockFilePayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
  maxHoldMs?: number;
};
type LockInspectionDetails = Pick<
  SessionLockInspection,
  "pid" | "pidAlive" | "createdAt" | "ageMs" | "stale" | "staleReasons"
>;

type SessionWriteLockTestApi = {
  resetSessionWriteLockStateForTest(): void;
  testing: {
    cleanupSignals: CleanupSignal[];
    handleTerminationSignal(signal: CleanupSignal): void;
    inspectLockPayloadForTest(
      payload: LockFilePayload | null,
      staleMs: number,
      nowMs: number,
      opts?: { respectMaxHold?: boolean },
    ): LockInspectionDetails;
    releaseAllLocksSync(): void;
    runLockWatchdogCheck(nowMs?: number): Promise<number>;
    resolveRemainingAcquireTimeoutMs(timeoutMs: number, startedAtMs: number, nowMs: number): number;
    setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void;
  };
};

function getTestApi(): SessionWriteLockTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionWriteLockTestApi")
  ] as SessionWriteLockTestApi;
}

export function resetSessionWriteLockStateForTest(): void {
  getTestApi().resetSessionWriteLockStateForTest();
}

export const testing = getTestApi().testing;
