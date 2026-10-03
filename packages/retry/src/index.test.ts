import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoff,
  computeBackoffSchedule,
  createRetryRunner,
  RetrySupervisor,
  retryAsync,
  sleepWithAbort,
} from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createRetryOperation() {
  return vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("retryable"))
    .mockResolvedValueOnce("ok");
}

describe("RetrySupervisor", () => {
  it("owns attempt counting, overrides, rebasing, and exhaustion", () => {
    const supervisor = new RetrySupervisor({ initialMs: 100, maxMs: 250, factor: 2, jitter: 0 }, 2);

    expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 100 });

    supervisor.nextDelayOverrideMs = 175;
    expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 175 });

    expect(supervisor.next()).toMatchObject({ attempt: 2, delayMs: 200 });
    expect(supervisor.next()).toBeUndefined();
    expect(supervisor.attempts).toBe(3);

    supervisor.reset(25);
    expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 25 });
  });

  it("uses exact capped schedules", () => {
    expect(
      [0, 1, 2, 3, 4, 5].map((attempt) => computeBackoffSchedule([5, 25, 120], attempt)),
    ).toEqual([0, 5, 25, 120, 120, 120]);
  });

  it("keeps long-lived exponential backoff at its cap", () => {
    expect(computeBackoff({ initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0 }, 1_016)).toBe(
      30_000,
    );
  });

  it("cancels a pending wait with the canonical abort error", async () => {
    vi.useFakeTimers();
    const supervisor = new RetrySupervisor({ initialMs: 100, maxMs: 100, factor: 2, jitter: 0 });
    const retry = supervisor.next();
    const wait = sleepWithAbort(retry?.delayMs ?? 0, retry?.signal);
    const reason = new Error("stop");
    supervisor.cancel(reason);

    await expect(wait).rejects.toMatchObject({
      name: "AbortError",
      message: "aborted",
      cause: reason,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can unref the scheduled timer", async () => {
    const controller = new AbortController();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const sleeper = sleepWithAbort(60_000, controller.signal, { ref: false });
      const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;

      expect(timer?.hasRef()).toBe(false);
      controller.abort();
      await expect(sleeper).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
    } finally {
      controller.abort();
    }
  });
});

describe("retryAsync", () => {
  it.each([
    ["fractional floor without jitter", 1.4, 0, 10, 0, 2],
    ["fractional floor with jitter", 1.4, 0, 10, 0.5, 2],
    ["server hint at the cap", 1_000, 1, 1_000, 0.5, 1_000],
    ["symmetric jitter above the cap", 10_000, 1, 1_000, 0.5, 500],
  ] as const)(
    "respects Retry-After: %s",
    async (_name, retryAfterMs, minDelayMs, maxDelayMs, jitter, expectedDelay) => {
      const sleeps: number[] = [];
      const run = createRetryRunner();

      await expect(
        run(createRetryOperation(), {
          attempts: 2,
          minDelayMs,
          maxDelayMs,
          jitter,
          random: () => 0,
          retryAfterMs: () => retryAfterMs,
          sleep: async (ms) => void sleeps.push(ms),
        }),
      ).resolves.toBe("ok");
      expect(sleeps).toEqual([expectedDelay]);
    },
  );

  it("supports custom schedules and async retry hooks", async () => {
    const events: string[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");

    await expect(
      retryAsync(operation, {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 100,
        delayMs: ({ attempt }) => [10, 30][attempt - 1] ?? 0,
        onRetry: async ({ attempt }) => void events.push(`retry:${attempt}`),
        sleep: async (ms) => void events.push(`sleep:${ms}`),
      }),
    ).resolves.toBe("ok");
    expect(events).toEqual(["retry:1", "sleep:10", "retry:2", "sleep:30"]);
  });

  it("preserves terminal Error identity", async () => {
    const terminal = new Error("terminal");
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(terminal);
    await expect(retryAsync(operation, { attempts: 1 })).rejects.toBe(terminal);
  });

  it("clamps numeric overload delays to the Node timer ceiling", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const operation = createRetryOperation();
    const result = createRetryRunner()(operation, 2, Number.POSITIVE_INFINITY);
    const settled = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(2_147_000_000 - 1);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toEqual({ value: "ok" });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(timer.mock.calls.map((call) => call[1])).toEqual([2_147_000_000]);
  });
});

describe("retry scheduler long native waits", () => {
  const TIMER_MAX_MS = 2_147_000_000;

  it("does not retry until every chunk of a long Retry-After has elapsed", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const operation = createRetryOperation();
    const onRetry = vi.fn();
    const delayMs = 2 * TIMER_MAX_MS + 123;
    const result = createRetryRunner()(operation, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      retryAfterMs: () => delayMs,
      onRetry,
    });
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(122);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(timer.mock.calls.map((call) => call[1])).toEqual([TIMER_MAX_MS, TIMER_MAX_MS, 123]);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ delayMs }));
  });

  it("splits a jitter-expanded delay instead of clipping the policy result", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const operation = createRetryOperation();
    const result = createRetryRunner()(operation, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      delayMs: TIMER_MAX_MS,
      jitter: "full",
      random: () => 1,
    });
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
    await expect(result).resolves.toBe("ok");
    expect(timer.mock.calls.map((call) => call[1])).toEqual([TIMER_MAX_MS, TIMER_MAX_MS]);
  });

  it("keeps short native waits and the numeric zero-delay yield", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    for (const delay of [0, 10]) {
      timer.mockClear();
      const operation = createRetryOperation();
      const result = createRetryRunner()(operation, 2, delay);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("ok");
      expect(timer.mock.calls.map((call) => call[1])).toEqual([delay]);
    }
  });

  it("does not split or shorten an explicitly supplied sleep implementation", async () => {
    const delayMs = 2 * TIMER_MAX_MS + 123;
    const sleep = vi.fn(async (_ms: number) => undefined);
    await createRetryRunner()(createRetryOperation(), {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      retryAfterMs: () => delayMs,
      sleep,
    });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(delayMs);
  });
});
