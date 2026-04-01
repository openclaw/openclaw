import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionCircuitBreaker } from "./compaction-circuit-breaker.js";

describe("CompactionCircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in closed state", () => {
    const cb = new CompactionCircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("stays closed after fewer than maxFailures", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("opens after maxFailures consecutive failures", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.canAttempt()).toBe(false);
  });

  it("transitions to half-open after resetAfterMs", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 2, resetAfterMs: 5000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.state).toBe("half-open");
    expect(cb.canAttempt()).toBe(true);
  });

  it("resets to closed on success", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(60_000);
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("reopens on failure in half-open state", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 2, resetAfterMs: 5000 });
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    expect(cb.state).toBe("half-open");

    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.canAttempt()).toBe(false);
  });

  it("success after some failures resets the counter", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.state).toBe("closed");

    // Need 3 new failures to open again
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  it("reset() clears all state", () => {
    const cb = new CompactionCircuitBreaker({ maxFailures: 1 });
    cb.recordFailure();
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("uses default config values", () => {
    const cb = new CompactionCircuitBreaker();
    // Default maxFailures is 3
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");

    // Default resetAfterMs is 60_000
    vi.advanceTimersByTime(59_999);
    expect(cb.state).toBe("open");
    vi.advanceTimersByTime(1);
    expect(cb.state).toBe("half-open");
  });
});
