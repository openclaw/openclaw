// Coverage for aggregate timeout handling while waiting on compaction retry.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";

type AggregateTimeoutParams = Parameters<typeof waitForCompactionRetryWithAggregateTimeout>[0];

async function withFakeTimers(run: () => Promise<void>) {
  // Ensure timer state is fully drained between cases because aggregate timeout
  // races can otherwise leak scheduled callbacks.
  vi.useFakeTimers();
  vi.clearAllTimers();
  try {
    await run();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

function buildAggregateTimeoutParams(
  overrides: Partial<AggregateTimeoutParams> &
    Pick<AggregateTimeoutParams, "waitForCompactionRetry">,
): AggregateTimeoutParams {
  // Defaults model the normal wait path; tests override only the timeout or
  // in-flight signal under review.
  return {
    waitForCompactionRetry: overrides.waitForCompactionRetry,
    abortable: overrides.abortable ?? (async (promise) => await promise),
    aggregateTimeoutMs: overrides.aggregateTimeoutMs ?? 60_000,
    isCompactionRetryStillActive: overrides.isCompactionRetryStillActive,
  };
}

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("keeps waiting while compaction retry work remains active", async () => {
    // The aggregate timer should not cut off either the compaction call or its
    // retry model run; timeout starts once both phases are idle.
    await withFakeTimers(async () => {
      let retryWorkActive = true;
      const waitForCompactionRetry = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              retryWorkActive = false;
              resolve();
            }, 170_000);
          }),
      );
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        isCompactionRetryStillActive: () => retryWorkActive,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(170_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("times out after an idle timeout window", async () => {
    await withFakeTimers(async () => {
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      setTimeout(() => {
        compactionInFlight = false;
      }, 90_000);
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        isCompactionRetryStillActive: () => compactionInFlight,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(120_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("caps aggregate timeout before scheduling", async () => {
    await withFakeTimers(async () => {
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const waitForCompactionRetry = vi.fn(async () => {});
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        aggregateTimeoutMs: Number.MAX_SAFE_INTEGER,
      });

      const result = await waitForCompactionRetryWithAggregateTimeout(params);

      expect(result.timedOut).toBe(false);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(vi.getTimerCount()).toBe(0);
      timeoutSpy.mockRestore();
    });
  });

  it("propagates immediate waitForCompactionRetry failures", async () => {
    await withFakeTimers(async () => {
      const waitError = new Error("compaction wait failed");
      const waitForCompactionRetry = vi.fn(async () => {
        throw waitError;
      });
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      await expect(waitForCompactionRetryWithAggregateTimeout(params)).rejects.toThrow(
        "compaction wait failed",
      );

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("handles waitForCompactionRetry rejection after timeout wins", async () => {
    await withFakeTimers(async () => {
      let rejectWait: ((error: Error) => void) | undefined;
      const waitForCompactionRetry = vi.fn(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectWait = reject;
          }),
      );
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      rejectWait?.(new Error("cancelled after timeout"));
      await Promise.resolve();

      expect(result.timedOut).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("propagates abort errors from abortable and clears timer", async () => {
    await withFakeTimers(async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        abortable: async () => {
          throw abortError;
        },
      });

      await expect(waitForCompactionRetryWithAggregateTimeout(params)).rejects.toThrow("aborted");

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("hasActiveCompactionRetryWork", () => {
  it.each([{ isCompactionInFlight: false, isSessionStreaming: true }])(
    "returns true while either retry phase is active",
    (params) => {
      expect(hasActiveCompactionRetryWork(params)).toBe(true);
    },
  );
});
