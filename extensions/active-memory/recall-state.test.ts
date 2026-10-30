import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildCircuitBreakerKey,
  isCircuitBreakerOpen,
  recordCircuitBreakerTimeout as recordTimeout,
  resetCircuitBreaker,
  shouldCacheResult,
} from "./recall-state.js";
import { DEFAULT_MAX_CACHE_ENTRIES } from "./types.js";

const circuitKeys = new Set<string>();
const cooldownMs = 5_000;
function recordCircuitBreakerTimeout(key: string) {
  circuitKeys.add(key);
  recordTimeout(key);
}

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

it.each([false, true])("evicts oldest entry (refresh first: %s)", (refresh) => {
  for (let index = 0; index < DEFAULT_MAX_CACHE_ENTRIES; index++) {
    recordCircuitBreakerTimeout(`model-${index}`);
  }
  if (refresh) {
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("model-0");
  }
  recordCircuitBreakerTimeout("newest");

  expect(isCircuitBreakerOpen("model-0", refresh ? 2 : 1, cooldownMs)).toBe(refresh);
  expect(isCircuitBreakerOpen("model-0", 3, cooldownMs)).toBe(false);
  expect(isCircuitBreakerOpen("model-1", 1, cooldownMs)).toBe(!refresh);
  expect(isCircuitBreakerOpen("newest", 1, cooldownMs)).toBe(true);
});

it("keeps circuit-breaker decisions scoped to the agent, provider, and model", () => {
  const timedOutKey = buildCircuitBreakerKey("agent-a", "provider-a", "model-a");
  recordCircuitBreakerTimeout(timedOutKey);
  expect(isCircuitBreakerOpen(timedOutKey, 1, cooldownMs)).toBe(true);
  for (const [agent, provider, model] of [
    ["agent-a", "provider-b", "model-a"],
    ["agent-a", "provider-a", "model-b"],
    ["agent-b", "provider-a", "model-a"],
  ] as const) {
    expect(
      isCircuitBreakerOpen(buildCircuitBreakerKey(agent, provider, model), 1, cooldownMs),
    ).toBe(false);
  }
});
