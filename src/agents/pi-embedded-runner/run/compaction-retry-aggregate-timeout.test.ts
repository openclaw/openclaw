import { describe, expect, it, vi } from "vitest";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";

async function withFakeTimers(run: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
}

function expectClearedTimeoutState(onTimeout: ReturnType<typeof vi.fn>, timedOut: boolean) {
  if (timedOut) {
    expect(onTimeout).toHaveBeenCalledTimes(1);
  } else {
    expect(onTimeout).not.toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
}

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("times out and fires callback when compaction retry never resolves", async () => {
    await withFakeTimers(async () => {
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
      expectClearedTimeoutState(onTimeout, true);
    });
  });

  it("keeps waiting while compaction remains in flight", async () => {
    await withFakeTimers(async () => {
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
      expectClearedTimeoutState(onTimeout, false);
    });
  });

  it("times out after an idle timeout window", async () => {
    await withFakeTimers(async () => {
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
      expectClearedTimeoutState(onTimeout, true);
    });
  });

  it("does not time out when compaction retry resolves", async () => {
    await withFakeTimers(async () => {
      const onTimeout = vi.fn();
      const waitForCompactionRetry = vi.fn(async () => {});

      const result = await waitForCompactionRetryWithAggregateTimeout({
        waitForCompactionRetry,
        abortable: async (promise) => await promise,
        aggregateTimeoutMs: 60_000,
        onTimeout,
      });

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(onTimeout, false);
    });
  });

  it("propagates abort errors from abortable and clears timer", async () => {
    await withFakeTimers(async () => {
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

      expectClearedTimeoutState(onTimeout, false);
    });
  });
});
