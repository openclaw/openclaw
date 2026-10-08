import { performance } from "node:perf_hooks";

export type QaLeaseClock = { wall: number; monotonic: number };

export function captureQaLeaseClock(): QaLeaseClock {
  return { wall: Date.now(), monotonic: performance.now() };
}

/** Timers can pause; every consumer also checks the last confirmed lease directly. */
export function createQaLeaseHealth(leaseTtlMs: number, acquiredAt: QaLeaseClock) {
  let confirmedAt = acquiredAt;
  let closed = false;
  let failure: Error | undefined;
  const assertHealthy = () => {
    if (closed) {
      throw new Error("QA credential lease has been released.");
    }
    if (!failure) {
      const now = captureQaLeaseClock();
      if (
        Math.max(now.wall - confirmedAt.wall, now.monotonic - confirmedAt.monotonic) >= leaseTtlMs
      ) {
        failure = new Error("QA credential lease expired before its owner could renew it.");
      }
    }
    if (failure) {
      throw failure;
    }
  };
  return {
    assertHealthy,
    confirm(requestStartedAt: QaLeaseClock) {
      assertHealthy();
      confirmedAt = requestStartedAt;
      assertHealthy();
    },
    close() {
      closed = true;
    },
  };
}
