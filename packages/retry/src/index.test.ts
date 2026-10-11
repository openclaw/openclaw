import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  computeBackoff,
  computeBackoffSchedule,
  createRetryRunner,
  type RetryOptions,
  RetrySupervisor,
  raceWithTimeout,
  retryAsync,
  sleepWithAbort,
} from "./index.js";

const TIMER_MAX_MS = 2_147_000_000;

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

describe("raceWithTimeout", () => {
  it("observes an existing abort when the operation factory throws synchronously", async () => {
    vi.useFakeTimers();
    const failure = new Error("failed to start");
    const signal = AbortSignal.abort("stopped");
    await expect(
      raceWithTimeout(
        () => {
          throw failure;
        },
        1_000,
        () => "expired",
        { signal },
      ),
    ).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it.each(["operation", "timeout", "abort"] as const)(
    "releases both cancellation and deadline observation when %s wins",
    async (winner) => {
      vi.useFakeTimers();
      const source = createDeferred<string>();
      const controller = new AbortController();
      const failure = new Error("cancelled");
      const pending = raceWithTimeout(source.promise, 10, () => "expired", {
        signal: controller.signal,
        onAbort: (signal) => {
          throw signal.reason;
        },
      });
      const outcome = pending.catch((error: unknown) => error);
      if (winner === "operation") {
        source.resolve("done");
      } else if (winner === "timeout") {
        await vi.advanceTimersByTimeAsync(10);
      } else {
        controller.abort(failure);
      }
      expect(await outcome).toBe(
        winner === "operation" ? "done" : winner === "timeout" ? "expired" : failure,
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      source.reject(new Error("late operation rejection"));
    },
  );

  it("keeps source-first race order while arming cancellation before work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = raceWithTimeout(
      () => {
        controller.abort();
        return Promise.resolve("done");
      },
      10,
      () => "expired",
      { signal: controller.signal },
    );
    await expect(pending).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("observes an existing abort without skipping an already-started operation", async () => {
    vi.useFakeTimers();
    const source = createDeferred<string>();
    const signal = AbortSignal.abort("stopped");
    await expect(
      raceWithTimeout(source.promise, 10, () => "expired", {
        signal,
        onAbort: () => "cancelled",
      }),
    ).resolves.toBe("cancelled");
    source.reject(new Error("late operation rejection"));
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("arms the deadline before starting work and clears it on a synchronous throw", async () => {
    vi.useFakeTimers();
    const failure = new Error("failed to start");
    const controller = new AbortController();
    const onAbort = vi.fn(() => "cancelled");
    const pending = raceWithTimeout(
      () => {
        expect(vi.getTimerCount()).toBe(1);
        throw failure;
      },
      1_000,
      () => "expired",
      { signal: controller.signal, onAbort },
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(onAbort).not.toHaveBeenCalled();
    await expect(pending).rejects.toBe(failure);
  });

  it.each(["fulfilled", "rejected"] as const)(
    "preserves a %s operation and releases its deadline",
    async (outcome) => {
      vi.useFakeTimers();
      const value = new Error("operation result");
      const onTimeout = vi.fn(() => "expired");
      const pending = raceWithTimeout(
        outcome === "fulfilled" ? Promise.resolve(value) : Promise.reject(value),
        1_000,
        onTimeout,
      );
      if (outcome === "fulfilled") {
        await expect(pending).resolves.toBe(value);
      } else {
        await expect(pending).rejects.toBe(value);
      }
      expect(vi.getTimerCount()).toBe(0);
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it.each([0, 25])("returns the timeout result after %i ms without cancelling work", async (ms) => {
    vi.useFakeTimers();
    const source = createDeferred<string>();
    const onTimeout = vi.fn(() => "expired");
    const pending = raceWithTimeout(source.promise, ms, onTimeout);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ms);
    await expect(pending).resolves.toBe("expired");
    expect(onTimeout).toHaveBeenCalledOnce();
    source.resolve("late result");
    await expect(source.promise).resolves.toBe("late result");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a timeout error and observes a late source rejection", async () => {
    vi.useFakeTimers();
    const source = createDeferred<never>();
    const timeoutError = new Error("expired");
    const pending = raceWithTimeout(source.promise, 10, () => {
      throw timeoutError;
    });
    const assertion = expect(pending).rejects.toBe(timeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    source.reject(new Error("late failure"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("preserves timer ref=%s", async (ref) => {
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const pending = raceWithTimeout(Promise.resolve("done"), 60_000, () => "expired", { ref });
    expect(scheduled.mock.results.at(-1)?.value.hasRef()).toBe(ref);
    await expect(pending).resolves.toBe("done");
  });
});

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
  it("passes Retry-After policy delays unchanged to runtime and option sleeps", async () => {
    const cases: [number, number, number, number, number, boolean?][] = [
      [1.4, 0, 10, 0, 2],
      [1.4, 0, 10, 0.5, 2],
      [1_000, 1, 1_000, 0.5, 1_000],
      [10_000, 1, 1_000, 0.5, 500],
      [2 * TIMER_MAX_MS + 123, 0, 0, 0, 2 * TIMER_MAX_MS + 123, true],
    ];
    for (const [
      retryAfterMs,
      minDelayMs,
      maxDelayMs,
      jitter,
      expectedDelay,
      optionSleep,
    ] of cases) {
      const sleep = vi.fn(async (_ms: number) => undefined);
      const run = createRetryRunner(optionSleep ? {} : { sleep });
      await expect(
        run(createRetryOperation(), {
          attempts: 2,
          minDelayMs,
          maxDelayMs,
          jitter,
          random: () => 0,
          retryAfterMs: () => retryAfterMs,
          ...(optionSleep ? { sleep } : {}),
        }),
      ).resolves.toBe("ok");
      expect(sleep).toHaveBeenCalledExactlyOnceWith(expectedDelay);
    }
  });

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
});

describe("retry scheduler long native waits", () => {
  it("honors full native waits, numeric clamping, and the zero-delay yield", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const onRetry = vi.fn();
    const delayMs = 2 * TIMER_MAX_MS + 123;
    const cases: {
      args: [RetryOptions | number, number?];
      advances: number[];
      timers: number[];
    }[] = [
      {
        args: [{ attempts: 2, minDelayMs: 0, maxDelayMs: 0, retryAfterMs: () => delayMs, onRetry }],
        advances: [TIMER_MAX_MS, TIMER_MAX_MS, 122],
        timers: [TIMER_MAX_MS, TIMER_MAX_MS, 123],
      },
      {
        args: [
          {
            attempts: 2,
            minDelayMs: 0,
            maxDelayMs: 0,
            delayMs: TIMER_MAX_MS,
            jitter: "full",
            random: () => 1,
          },
        ],
        advances: [TIMER_MAX_MS],
        timers: [TIMER_MAX_MS, TIMER_MAX_MS],
      },
      { args: [2, 0], advances: [], timers: [0] },
      { args: [2, 10], advances: [], timers: [10] },
      { args: [2, Infinity], advances: [], timers: [TIMER_MAX_MS] },
    ];
    for (const { args, advances, timers } of cases) {
      timer.mockClear();
      const operation = createRetryOperation();
      const result = createRetryRunner()(operation, ...args);
      for (const advance of advances) {
        await vi.advanceTimersByTimeAsync(advance);
        expect(operation).toHaveBeenCalledOnce();
      }
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(timer.mock.calls.map((call) => call[1])).toEqual(timers);
    }
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ delayMs }));
  });
});
