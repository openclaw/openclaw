import { describe, expect, it, vi } from "vitest";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("times out and fires callback when compaction retry never resolves", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));

      const resultPromise = waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (promise) => await promise,
        aggregateTimeoutMs: 60_000,
        onTimeout,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps waiting while compaction remains in flight", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              compactionInFlight = false;
              resolve();
            }, 170_000);
          }),
      );

      const resultPromise = waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (promise) => await promise,
        aggregateTimeoutMs: 60_000,
        onTimeout,
        isCompactionStillInFlight: () => compactionInFlight,
      });

      await vi.advanceTimersByTimeAsync(170_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("times out after an idle timeout window", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      setTimeout(() => {
        compactionInFlight = false;
      }, 90_000);

      const resultPromise = waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (promise) => await promise,
        aggregateTimeoutMs: 60_000,
        onTimeout,
        isCompactionStillInFlight: () => compactionInFlight,
      });

      await vi.advanceTimersByTimeAsync(120_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("does not time out when compaction retry resolves", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => {});

      const result = await waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (promise) => await promise,
        aggregateTimeoutMs: 60_000,
        onTimeout,
      });

      expect(result.timedOut).toBe(false);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("propagates abort errors from abortable and clears timer", async () => {
    vi.useFakeTimers();
    try {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));

      await expect(
        waitForCompactionRetryWithAggregateTimeout({
          waitForCompactionRetry,
          abortable: async () => {
            throw abortError;
          },
          aggregateTimeoutMs: 60_000,
          onTimeout,
        }),
      ).rejects.toThrow("aborted");

      expect(onTimeout).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
