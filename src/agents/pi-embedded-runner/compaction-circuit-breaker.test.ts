import { afterEach, describe, expect, it } from "vitest";
import {
  getCompactionCircuitState,
  isCompactionCircuitOpen,
  recordCompactionFailure,
  recordCompactionSuccess,
  resetCompactionCircuit,
  __testing,
} from "./compaction-circuit-breaker.js";

const { DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_COOLDOWN_MS } = __testing;

describe("compaction-circuit-breaker", () => {
  afterEach(() => {
    resetCompactionCircuit("test-session");
  });

  it("circuit is closed with zero failures", () => {
    expect(isCompactionCircuitOpen("test-session")).toBe(false);
  });

  it("circuit stays closed below threshold", () => {
    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES - 1; i++) {
      recordCompactionFailure("test-session", { nowMs: 1000 });
    }
    expect(isCompactionCircuitOpen("test-session", { nowMs: 1000 })).toBe(false);
  });

  it("circuit opens at threshold during cooldown", () => {
    const now = 100_000;
    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
      recordCompactionFailure("test-session", { nowMs: now });
    }
    // Still in cooldown
    expect(isCompactionCircuitOpen("test-session", { nowMs: now + 1000 })).toBe(true);
  });

  it("circuit half-opens after cooldown expires", () => {
    const now = 100_000;
    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
      recordCompactionFailure("test-session", { nowMs: now, cooldownMs: 1000 });
    }
    // After cooldown (exponential: 1000 * 2^(3-1) = 4000ms for 3rd failure)
    expect(isCompactionCircuitOpen("test-session", { nowMs: now + 5000 })).toBe(false);
  });

  it("success resets the circuit", () => {
    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
      recordCompactionFailure("test-session", { nowMs: 1000 });
    }
    recordCompactionSuccess("test-session");
    const state = getCompactionCircuitState("test-session");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.cooldownUntil).toBe(0);
    expect(isCompactionCircuitOpen("test-session")).toBe(false);
  });

  it("exponential backoff increases cooldown with each failure", () => {
    const now = 100_000;
    recordCompactionFailure("test-session", { nowMs: now, cooldownMs: 1000 });
    const state1 = getCompactionCircuitState("test-session");
    // 1st failure: 1000 * 2^0 = 1000
    expect(state1.cooldownUntil).toBe(now + 1000);

    recordCompactionFailure("test-session", { nowMs: now, cooldownMs: 1000 });
    const state2 = getCompactionCircuitState("test-session");
    // 2nd failure: 1000 * 2^1 = 2000
    expect(state2.cooldownUntil).toBe(now + 2000);

    recordCompactionFailure("test-session", { nowMs: now, cooldownMs: 1000 });
    const state3 = getCompactionCircuitState("test-session");
    // 3rd failure: 1000 * 2^2 = 4000
    expect(state3.cooldownUntil).toBe(now + 4000);
  });

  it("backoff is capped at 30 minutes", () => {
    const now = 100_000;
    // Simulate many failures with large base cooldown
    for (let i = 0; i < 20; i++) {
      recordCompactionFailure("test-session", { nowMs: now, cooldownMs: DEFAULT_COOLDOWN_MS });
    }
    const state = getCompactionCircuitState("test-session");
    expect(state.cooldownUntil).toBeLessThanOrEqual(now + 30 * 60 * 1000);
  });

  it("different sessions have independent circuits", () => {
    recordCompactionFailure("session-a", { nowMs: 1000 });
    recordCompactionFailure("session-a", { nowMs: 1000 });
    recordCompactionFailure("session-a", { nowMs: 1000 });
    expect(isCompactionCircuitOpen("session-a", { nowMs: 1001 })).toBe(true);
    expect(isCompactionCircuitOpen("session-b", { nowMs: 1001 })).toBe(false);
    resetCompactionCircuit("session-a");
    resetCompactionCircuit("session-b");
  });
});
