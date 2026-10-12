/** Timers can pause; every consumer also checks the last confirmed lease directly. */
export function createQaLeaseHealth(leaseTtlMs: number, acquiredAt: number) {
  let confirmedAt = acquiredAt;
  let closed = false;
  let failure: Error | undefined;
  const assertHealthy = () => {
    if (closed) {
      throw new Error("QA credential lease has been released.");
    }
    if (!failure) {
      // Broker TTLs elapse during host suspend, unlike a process monotonic clock.
      if (Date.now() - confirmedAt >= leaseTtlMs) {
        failure = new Error("QA credential lease expired before its owner could renew it.");
      }
    }
    if (failure) {
      throw failure;
    }
  };
  return {
    assertHealthy,
    confirm(requestStartedAt: number) {
      assertHealthy();
      confirmedAt = requestStartedAt;
      assertHealthy();
    },
    close() {
      closed = true;
    },
  };
}
