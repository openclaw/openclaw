import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureCircuitBreaker,
  getCircuitBreakerSpawnError,
  getCircuitBreakerStatus,
  isCircuitOpen,
  recordSpawnFailure,
  resetCircuitBreakerForTests,
} from "./subagent-circuit-breaker.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

beforeEach(() => {
  resetCircuitBreakerForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subagent-circuit-breaker", () => {
  it("should start in closed state", () => {
    const status = getCircuitBreakerStatus();
    expect(status.state).toBe("closed");
    expect(status.recentFailures).toBe(0);
    expect(status.trippedAt).toBeNull();
  });

  it("should not trip on non-relevant errors", () => {
    recordSpawnFailure("some random error");
    recordSpawnFailure("another error");
    recordSpawnFailure("third error");
    recordSpawnFailure("fourth error");
    expect(isCircuitOpen()).toBe(false);
  });

  it("should trip after threshold overload failures", () => {
    recordSpawnFailure("overloaded");
    recordSpawnFailure("rate limit exceeded");
    recordSpawnFailure("429 too many requests");
    expect(isCircuitOpen()).toBe(true);
  });

  it("should count 503 errors as relevant", () => {
    recordSpawnFailure("503 service unavailable");
    recordSpawnFailure("503 service unavailable");
    recordSpawnFailure("503 service unavailable");
    expect(isCircuitOpen()).toBe(true);
  });

  it("should count 'too many' errors as relevant", () => {
    recordSpawnFailure("too many requests");
    recordSpawnFailure("too many connections");
    recordSpawnFailure("too many spawns");
    expect(isCircuitOpen()).toBe(true);
  });

  it("should reset after cooldown", () => {
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    expect(isCircuitOpen()).toBe(true);

    vi.advanceTimersByTime(180_000); // default cooldown
    expect(isCircuitOpen()).toBe(false);
  });

  it("should provide actionable error message when open", () => {
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    const msg = getCircuitBreakerSpawnError();
    expect(msg).toContain("temporarily paused");
    expect(msg).toContain("Retry in");
  });

  it("should prune old failures outside window", () => {
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    vi.advanceTimersByTime(310_000); // past 5 min window
    recordSpawnFailure("overloaded");
    // Only 1 failure in window — should not trip
    expect(isCircuitOpen()).toBe(false);
  });

  it("should accept custom configuration", () => {
    configureCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 60_000,
    });
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    expect(isCircuitOpen()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isCircuitOpen()).toBe(false);
  });

  it("should NOT count failures without error string", () => {
    recordSpawnFailure();
    recordSpawnFailure();
    recordSpawnFailure();
    expect(isCircuitOpen()).toBe(false);
  });

  it("should NOT count empty string as relevant", () => {
    recordSpawnFailure("");
    recordSpawnFailure("");
    recordSpawnFailure("");
    expect(isCircuitOpen()).toBe(false);
  });

  it("should handle concurrent isCircuitOpen + recordSpawnFailure interleaving", () => {
    // Record 2 failures, check state, then add the 3rd
    recordSpawnFailure("overloaded");
    expect(isCircuitOpen()).toBe(false);
    recordSpawnFailure("429");
    expect(isCircuitOpen()).toBe(false);
    recordSpawnFailure("rate limit");
    expect(isCircuitOpen()).toBe(true);
    // Advancing part of cooldown shouldn't reset
    vi.advanceTimersByTime(100_000);
    expect(isCircuitOpen()).toBe(true);
    // Recording more failures while open shouldn't change state
    recordSpawnFailure("overloaded");
    expect(isCircuitOpen()).toBe(true);
    // Full cooldown resets
    vi.advanceTimersByTime(80_000);
    expect(isCircuitOpen()).toBe(false);
  });

  it("should show cooldown remaining", () => {
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    recordSpawnFailure("overloaded");
    vi.advanceTimersByTime(60_000);
    const status = getCircuitBreakerStatus();
    expect(status.cooldownRemainingMs).toBe(120_000);
  });
});
