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
function recordCircuitBreakerTimeout(key: string) {
  circuitKeys.add(key);
  recordTimeout(key);
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

  it("allows elapsed cooldown without disturbing more recent circuits", () => {
    const cooldownMs = 5_000;
    recordCircuitBreakerTimeout("old");
    vi.advanceTimersByTime(cooldownMs - 1);
    recordCircuitBreakerTimeout("recent");
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("new");

    expect(isCircuitBreakerOpen("old", 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen("recent", 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen("new", 1, cooldownMs)).toBe(true);
  });

  it("counts spaced timeouts even when another key times out between them", () => {
    const cooldownMs = 5_000;
    recordCircuitBreakerTimeout("same");
    for (let index = 0; index < 2; index++) {
      vi.advanceTimersByTime(cooldownMs + 1);
      recordCircuitBreakerTimeout("peer");
      recordCircuitBreakerTimeout("same");
    }

    expect(isCircuitBreakerOpen("same", 3, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen("peer", 3, cooldownMs)).toBe(false);
  });

  it("retains the timeout streak through a cooldown probe until reset", () => {
    const cooldownMs = 5_000;
    recordCircuitBreakerTimeout("probe");
    recordCircuitBreakerTimeout("probe");
    expect(isCircuitBreakerOpen("probe", 2, cooldownMs)).toBe(true);

    vi.advanceTimersByTime(cooldownMs);
    expect(isCircuitBreakerOpen("probe", 2, cooldownMs)).toBe(false);
    recordCircuitBreakerTimeout("probe");
    expect(isCircuitBreakerOpen("probe", 2, cooldownMs)).toBe(true);

    resetCircuitBreaker("probe");
    recordCircuitBreakerTimeout("probe");
    expect(isCircuitBreakerOpen("probe", 2, cooldownMs)).toBe(false);
  });

  it("evicts the oldest key when the existing cache capacity is exceeded", () => {
    const cooldownMs = 120_000;
    for (let index = 0; index <= DEFAULT_MAX_CACHE_ENTRIES; index++) {
      recordCircuitBreakerTimeout(`model-${index}`);
    }

    expect(isCircuitBreakerOpen("model-0", 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen("model-1", 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen(`model-${DEFAULT_MAX_CACHE_ENTRIES}`, 1, cooldownMs)).toBe(true);
  });

  it("refreshes an existing key before evicting the least recently updated peer", () => {
    const cooldownMs = 120_000;
    for (let index = 0; index < DEFAULT_MAX_CACHE_ENTRIES; index++) {
      recordCircuitBreakerTimeout(`model-${index}`);
    }
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("model-0");
    recordCircuitBreakerTimeout("newest");

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

    recordCircuitBreakerTimeout(timedOutKey);

    expect(isCircuitBreakerOpen(timedOutKey, 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen(otherProviderKey, 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen(otherModelKey, 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen(otherAgentKey, 1, cooldownMs)).toBe(false);
  });
});
