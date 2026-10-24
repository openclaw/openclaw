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

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllTimers();
  });
  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps waiting while compaction retry work remains active", async () => {
    let retryWorkActive = true;
    const result = waitForRetry({
      waitForCompactionRetry: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            retryWorkActive = false;
            resolve();
          }, 170_000);
        }),
      isCompactionRetryStillActive: () => retryWorkActive,
    });
    await vi.advanceTimersByTimeAsync(170_000);
    expect((await result).timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out after an idle timeout window", async () => {
    let compactionInFlight = true;
    setTimeout(() => {
      compactionInFlight = false;
    }, 90_000);
    const result = waitForRetry({ isCompactionRetryStillActive: () => compactionInFlight });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await result).timedOut).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps aggregate timeout before scheduling", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const result = await waitForRetry({
        waitForCompactionRetry: async () => {},
        aggregateTimeoutMs: Number.MAX_SAFE_INTEGER,
      });
      expect(result.timedOut).toBe(false);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
    }
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
    const settled = await result;
    wait.reject(new Error("cancelled after timeout"));
    await Promise.resolve();
    expect(settled.timedOut).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("returns true while the retry model is streaming", () => {
  expect(
    hasActiveCompactionRetryWork({
      isCompactionInFlight: false,
      isSessionStreaming: true,
    }),
  ).toBe(true);
});
