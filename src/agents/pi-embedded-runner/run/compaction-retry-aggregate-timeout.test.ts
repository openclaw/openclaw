import { describe, expect, it, vi } from "vitest";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";

type AggregateTimeoutParams = Parameters<typeof waitForCompactionRetryWithAggregateTimeout>[0];

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

function buildAggregateTimeoutParams(
  overrides: Partial<AggregateTimeoutParams> &
    Pick<AggregateTimeoutParams, "waitForCompactionRetry">,
): { params: AggregateTimeoutParams; onTimeoutSpy: ReturnType<typeof vi.fn> } {
  const onTimeoutSpy = vi.fn();
  const onTimeout = overrides.onTimeout ?? (() => onTimeoutSpy());
  return {
    params: {
      waitForCompactionRetry: overrides.waitForCompactionRetry,
      abortable: overrides.abortable ?? (async (promise) => await promise),
      aggregateTimeoutMs: overrides.aggregateTimeoutMs ?? 60_000,
      isCompactionStillInFlight: overrides.isCompactionStillInFlight,
      onTimeout,
    },
    onTimeoutSpy,
  };
}

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("times out and fires callback when compaction retry never resolves", async () => {
    await withFakeTimers(async () => {
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      const { params, onTimeoutSpy } = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(onTimeoutSpy, true);
    });
  });

  it("keeps waiting while compaction remains in flight", async () => {
    await withFakeTimers(async () => {
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
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        isCompactionStillInFlight: () => compactionInFlight,
      });
      const { params: aggregateTimeoutParams, onTimeoutSpy } = params;

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(aggregateTimeoutParams);

      await vi.advanceTimersByTimeAsync(170_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(onTimeoutSpy, false);
    });
  });

  it("times out after an idle timeout window", async () => {
    await withFakeTimers(async () => {
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      setTimeout(() => {
        compactionInFlight = false;
      }, 90_000);
      const { params, onTimeoutSpy } = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        isCompactionStillInFlight: () => compactionInFlight,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(120_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(onTimeoutSpy, true);
    });
  });

  it("does not time out when compaction retry resolves", async () => {
    await withFakeTimers(async () => {
      const waitForCompactionRetry = vi.fn(async () => {});
      const { params, onTimeoutSpy } = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const result = await waitForCompactionRetryWithAggregateTimeout(params);

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(onTimeoutSpy, false);
    });
  });

  it("propagates abort errors from abortable and clears timer", async () => {
    await withFakeTimers(async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      const { params, onTimeoutSpy } = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        abortable: async () => {
          throw abortError;
        },
      });

      await expect(waitForCompactionRetryWithAggregateTimeout(params)).rejects.toThrow("aborted");

      expectClearedTimeoutState(onTimeoutSpy, false);
    });
  });
});
