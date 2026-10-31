import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout as aggregateWait,
} from "./compaction-retry-aggregate-timeout.js";

function waitForRetry(overrides: Partial<Parameters<typeof aggregateWait>[0]> = {}) {
  return aggregateWait({
    waitForCompactionRetry: () => new Promise<void>(() => {}),
    abortable: async (promise) => await promise,
    aggregateTimeoutMs: 60_000,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  const pendingTimers = vi.getTimerCount();
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(pendingTimers).toBe(0);
});

it.each([true, false])(
  "extends active work, then settles (retry completes: %s)",
  async (completes) => {
    const retry = createDeferredCore();
    let active = true;
    const result = waitForRetry({
      waitForCompactionRetry: () => retry.promise,
      isCompactionRetryStillActive: () =>
        hasActiveCompactionRetryWork({ isCompactionInFlight: false, isSessionStreaming: active }),
    });
    await vi.advanceTimersByTimeAsync(170_000);
    active = false;
    if (completes) {
      retry.resolve();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ timedOut: !completes });
  },
);

it.each([
  ["waitForCompactionRetry", new Error("compaction wait failed")],
  ["abortable", Object.assign(new Error("aborted"), { name: "AbortError" })],
] as const)("propagates %s failures and clears the timer", async (callback, error) => {
  const result = waitForRetry({ [callback]: () => Promise.reject(error) });
  await expect(result).rejects.toThrow(error.message);
});

it("handles waitForCompactionRetry rejection after timeout wins", async () => {
  const wait = createDeferredCore();
  const result = waitForRetry({ waitForCompactionRetry: () => wait.promise });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toEqual({ timedOut: true });
  wait.reject(new Error("cancelled after timeout"));
  await Promise.resolve();
});
