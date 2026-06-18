// Coverage for aggregate timeout handling while waiting on compaction retry.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
  COMPACTION_RETRY_AGGREGATE_TIMEOUT_MARGIN_MS,
  resolveCompactionRetryAggregateTimeoutMs,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";

type AggregateTimeoutParams = Parameters<typeof waitForCompactionRetryWithAggregateTimeout>[0];
type TimeoutCallback = NonNullable<AggregateTimeoutParams["onTimeout"]>;
type TimeoutCallbackMock = ReturnType<typeof vi.fn<TimeoutCallback>>;

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

function expectClearedTimeoutState(onTimeout: TimeoutCallbackMock, timedOut: boolean) {
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
): AggregateTimeoutParams & { onTimeout: TimeoutCallbackMock } {
  // Defaults model the normal wait path; tests override only the timeout or
  // in-flight signal under review.
  const onTimeout =
    (overrides.onTimeout as TimeoutCallbackMock | undefined) ?? vi.fn<TimeoutCallback>();
  return {
    waitForCompactionRetry: overrides.waitForCompactionRetry,
    abortable: overrides.abortable ?? (async (promise) => await promise),
    aggregateTimeoutMs: overrides.aggregateTimeoutMs ?? 60_000,
    isCompactionStillInFlight: overrides.isCompactionStillInFlight,
    onTimeout,
  };
}

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("times out and fires callback when compaction retry never resolves", async () => {
    await withFakeTimers(async () => {
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(params.onTimeout, true);
    });
  });

  it("keeps waiting while compaction remains in flight", async () => {
    // The aggregate timer should not cut off active compaction work; timeout
    // starts once compaction is no longer in flight.
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

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(170_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(params.onTimeout, false);
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
        isCompactionStillInFlight: () => compactionInFlight,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(120_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(params.onTimeout, true);
    });
  });

  it("does not time out when compaction retry resolves", async () => {
    await withFakeTimers(async () => {
      const waitForCompactionRetry = vi.fn(async () => {});
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const result = await waitForCompactionRetryWithAggregateTimeout(params);

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(params.onTimeout, false);
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
      expectClearedTimeoutState(params.onTimeout, false);
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

      expectClearedTimeoutState(params.onTimeout, false);
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
      expectClearedTimeoutState(params.onTimeout, true);
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

      expectClearedTimeoutState(params.onTimeout, false);
    });
  });
});

describe("resolveCompactionRetryAggregateTimeoutMs", () => {
  // Regression coverage for #94391: hardcoded 60s outer wait used to abandon
  // valid compaction results on slow ~200K-token sessions.
  it("falls back to the historical 60s floor when no inner timeout is provided", () => {
    expect(resolveCompactionRetryAggregateTimeoutMs(undefined)).toBe(
      COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    );
  });

  it("falls back to the floor for non-finite or non-positive inputs", () => {
    expect(resolveCompactionRetryAggregateTimeoutMs(0)).toBe(
      COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    );
    expect(resolveCompactionRetryAggregateTimeoutMs(-1_000)).toBe(
      COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    );
    expect(resolveCompactionRetryAggregateTimeoutMs(Number.NaN)).toBe(
      COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    );
    expect(resolveCompactionRetryAggregateTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    );
  });

  it("keeps the floor when the inner timeout would resolve below it", () => {
    expect(resolveCompactionRetryAggregateTimeoutMs(15_000)).toBe(
      COMPACTION_RETRY_AGGREGATE_TIMEOUT_FLOOR_MS,
    );
  });

  it("adds a margin on top of the inner compaction timeout", () => {
    // Default install: compaction.timeoutSeconds=180 → outer wait covers the
    // inner cap so a slow but still-completing compaction is consumed instead
    // of discarded.
    expect(resolveCompactionRetryAggregateTimeoutMs(180_000)).toBe(
      180_000 + COMPACTION_RETRY_AGGREGATE_TIMEOUT_MARGIN_MS,
    );
    // Operator override: compaction.timeoutSeconds=300 → outer wait scales.
    expect(resolveCompactionRetryAggregateTimeoutMs(300_000)).toBe(
      300_000 + COMPACTION_RETRY_AGGREGATE_TIMEOUT_MARGIN_MS,
    );
  });

  it("waits the full configured budget before timing out (regression: #94391)", async () => {
    // Mirrors the field repro: compaction model call returns at ~174s while
    // the outer wait, wired to compaction.timeoutSeconds=300, must not fire
    // at the legacy 60s mark.
    await withFakeTimers(async () => {
      const aggregateTimeoutMs = resolveCompactionRetryAggregateTimeoutMs(300_000);
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              compactionInFlight = false;
              resolve();
            }, 174_000);
          }),
      );
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        aggregateTimeoutMs,
        isCompactionStillInFlight: () => compactionInFlight,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      // Past the legacy 60s budget: the wait must still be in flight.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(params.onTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(174_000 - 60_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(params.onTimeout, false);
    });
  });
});
