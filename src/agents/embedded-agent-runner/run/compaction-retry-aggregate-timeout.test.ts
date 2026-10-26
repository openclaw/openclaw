import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";

type AggregateTimeoutParams = Parameters<typeof waitForCompactionRetryWithAggregateTimeout>[0];

function waitForRetry(overrides: Partial<AggregateTimeoutParams> = {}) {
  return waitForCompactionRetryWithAggregateTimeout({
    waitForCompactionRetry: () => new Promise<void>(() => {}),
    abortable: async (promise) => await promise,
    aggregateTimeoutMs: 60_000,
    ...overrides,
  });
}

async function expectSettled(result: ReturnType<typeof waitForRetry>, timedOut: boolean) {
  expect(await result).toEqual({ timedOut });
  expect(vi.getTimerCount()).toBe(0);
}

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([true, false])(
    "extends active work, then settles (retry completes: %s)",
    async (completes) => {
      const retry = createDeferredCore();
      let active = true;
      const result = waitForRetry({
        waitForCompactionRetry: () => retry.promise,
        isCompactionRetryStillActive: () => active,
      });
      await vi.advanceTimersByTimeAsync(170_000);
      active = false;
      if (completes) {
        retry.resolve();
      }
      await vi.advanceTimersByTimeAsync(10_000);
      await expectSettled(result, !completes);
    },
  );

  it("caps aggregate timeout before scheduling", async () => {
    using timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = waitForRetry({
      waitForCompactionRetry: async () => {},
      aggregateTimeoutMs: Number.MAX_SAFE_INTEGER,
    });
    await expectSettled(result, false);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it.each([
    ["waitForCompactionRetry", new Error("compaction wait failed")],
    ["abortable", Object.assign(new Error("aborted"), { name: "AbortError" })],
  ] as const)("propagates %s failures and clears the timer", async (callback, error) => {
    await expect(
      waitForRetry({
        [callback]: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow(error.message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles waitForCompactionRetry rejection after timeout wins", async () => {
    const wait = createDeferredCore();
    const result = waitForRetry({ waitForCompactionRetry: () => wait.promise });
    await vi.advanceTimersByTimeAsync(60_000);
    await expectSettled(result, true);
    wait.reject(new Error("cancelled after timeout"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("returns true while the retry model is streaming", () => {
  expect(
    hasActiveCompactionRetryWork({ isCompactionInFlight: false, isSessionStreaming: true }),
  ).toBe(true);
});
