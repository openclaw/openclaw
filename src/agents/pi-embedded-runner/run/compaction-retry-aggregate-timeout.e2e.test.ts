import { describe, expect, it, vi } from "vitest";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("fires an aggregate timeout and proceeds when compaction retry never resolves", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));

      const resultPromise = waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (p) => await p,
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

  it("does not time out when compaction retry resolves quickly, and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => {});

      const result = await waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (p) => await p,
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

  it("propagates abort errors from abortable and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const abortErr = new Error("aborted");
      abortErr.name = "AbortError";

      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));

      await expect(
        waitForCompactionRetryWithAggregateTimeout({
          waitForCompactionRetry,
          abortable: async () => {
            throw abortErr;
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
