import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCircuitBreakerKey,
  isCircuitBreakerOpen,
  recordCircuitBreakerTimeout as recordTimeout,
  resetCircuitBreaker,
  shouldCacheResult,
} from "./recall-state.js";
import { DEFAULT_MAX_CACHE_ENTRIES } from "./types.js";

const circuitKeys = new Set<string>();
function recordCircuitBreakerTimeout(key: string, cooldownMs: number) {
  circuitKeys.add(key);
  recordTimeout(key, cooldownMs);
}

describe("active-memory timeout circuit breakers", () => {
  it.each([
    [{ status: "timeout_partial", elapsedMs: 1, summary: "partial" }, false],
    [{ status: "ok", elapsedMs: 1, rawReply: "full", summary: "full" }, true],
  ] as const)("applies cache eligibility to %#", (result, expected) => {
    expect(shouldCacheResult(result)).toBe(expected);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    for (const key of circuitKeys) {
      resetCircuitBreaker(key);
    }
    circuitKeys.clear();
    vi.useRealTimers();
  });

  it("keeps recent timeout circuits active after earlier circuits expire", () => {
    const cooldownMs = 5_000;
    recordCircuitBreakerTimeout("old", cooldownMs);
    vi.advanceTimersByTime(cooldownMs - 1);
    recordCircuitBreakerTimeout("recent", cooldownMs);
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("new", cooldownMs);

    expect(isCircuitBreakerOpen("old", 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen("recent", 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen("new", 1, cooldownMs)).toBe(true);
  });

  it("restarts an expired key before adding a new timeout", () => {
    const cooldownMs = 5_000;
    recordCircuitBreakerTimeout("same", cooldownMs);
    vi.advanceTimersByTime(cooldownMs);
    recordCircuitBreakerTimeout("same", cooldownMs);

    expect(isCircuitBreakerOpen("same", 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen("same", 2, cooldownMs)).toBe(false);
  });

  it("evicts the oldest key when the existing cache capacity is exceeded", () => {
    const cooldownMs = 120_000;
    for (let index = 0; index <= DEFAULT_MAX_CACHE_ENTRIES; index++) {
      recordCircuitBreakerTimeout(`model-${index}`, cooldownMs);
    }

    expect(isCircuitBreakerOpen("model-0", 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen("model-1", 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen(`model-${DEFAULT_MAX_CACHE_ENTRIES}`, 1, cooldownMs)).toBe(true);
  });

  it("refreshes an existing key before evicting the least recently updated peer", () => {
    const cooldownMs = 120_000;
    for (let index = 0; index < DEFAULT_MAX_CACHE_ENTRIES; index++) {
      recordCircuitBreakerTimeout(`model-${index}`, cooldownMs);
    }
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("model-0", cooldownMs);
    recordCircuitBreakerTimeout("newest", cooldownMs);

    expect(isCircuitBreakerOpen("model-0", 2, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen("model-0", 3, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen("model-1", 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen("newest", 1, cooldownMs)).toBe(true);
  });

  it("keeps circuit-breaker decisions scoped to the agent, provider, and model", () => {
    const cooldownMs = 5_000;
    const timedOutKey = buildCircuitBreakerKey("agent-a", "provider-a", "model-a");
    const otherProviderKey = buildCircuitBreakerKey("agent-a", "provider-b", "model-a");
    const otherModelKey = buildCircuitBreakerKey("agent-a", "provider-a", "model-b");
    const otherAgentKey = buildCircuitBreakerKey("agent-b", "provider-a", "model-a");

    recordCircuitBreakerTimeout(timedOutKey, cooldownMs);

    expect(isCircuitBreakerOpen(timedOutKey, 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen(otherProviderKey, 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen(otherModelKey, 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen(otherAgentKey, 1, cooldownMs)).toBe(false);
  });
});
