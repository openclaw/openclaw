// extensions/safety-harness/circuit-breaker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts in closed state (normal)", () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.isDegraded()).toBe(false);
  });

  it("stays closed after 1-2 failures", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("closed");
  });

  it("opens (degraded) after 3 consecutive failures within 5 min", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isDegraded()).toBe(true);
  });

  it("resets on success", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    // A third failure should not trip because counter was reset
    cb.recordFailure();
    expect(cb.state).toBe("closed");
  });

  it("auto-recovers from degraded after one success", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isDegraded()).toBe(true);
    cb.recordSuccess();
    expect(cb.isDegraded()).toBe(false);
    expect(cb.state).toBe("closed");
  });

  it("does not trip if failures are spread over >5 minutes", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(6 * 60_000); // 6 minutes
    cb.recordFailure();
    // Only 1 failure within the 5-min window
    expect(cb.state).toBe("closed");
  });
});
