import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const retryOptions = { attempts: 2, minDelayMs: 0, maxDelayMs: 0 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function createRetryOperation(failures = 1) {
  const operation = vi.fn<() => Promise<string>>();
  for (let i = 0; i < failures; i++) {
    operation.mockRejectedValueOnce(new Error("retryable"));
  }
  return operation.mockResolvedValueOnce("ok");
}

function deadline<T>(
  operation: Promise<T> | (() => Promise<T>),
  options: { signal?: AbortSignal; onAbort?: (signal: AbortSignal) => string } = {},
) {
  return raceWithTimeout(operation, 10, () => "expired", options);
}

function expectTimers(signal: AbortSignal, count = 0) {
  expect([vi.getTimerCount(), getEventListeners(signal, "abort").length]).toEqual([count, count]);
}

async function expectAbortedSleep(promise: Promise<void>): Promise<Error> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  assert(error instanceof Error, "expected aborted sleep");
  expect(error.message).toBe("aborted");
  return error;
}

it("observes an existing abort when the operation factory throws synchronously", async () => {
  const failure = new Error("failed to start");
  const signal = AbortSignal.abort("stopped");
  const operation = () => {
    expect(vi.getTimerCount()).toBe(1);
    throw failure;
  };
  await expect(deadline(operation, { signal })).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(0);
  expectTimers(signal);
});

it.each(["operation", "timeout", "abort"] as const)(
  "releases both cancellation and deadline observation when %s wins",
  async (winner) => {
    const source = createDeferred<string>();
    const controller = new AbortController();
    const failure = new Error("cancelled");
    const pending = deadline(source.promise, {
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
    expectTimers(controller.signal);
    source.reject(new Error("late operation rejection"));
  },
);

it("keeps source-first race order while arming cancellation before work", async () => {
  const controller = new AbortController();
  const operation = () => {
    controller.abort();
    return Promise.resolve("done");
  };
  const pending = deadline(operation, { signal: controller.signal });
  await expect(pending).resolves.toBe("done");
  expectTimers(controller.signal);
});

it("observes an existing abort without skipping an already-started operation", async () => {
  const source = createDeferred<string>();
  const signal = AbortSignal.abort("stopped");
  const pending = deadline(source.promise, { signal, onAbort: () => "cancelled" });
  await expect(pending).resolves.toBe("cancelled");
  source.reject(new Error("late operation rejection"));
  expectTimers(signal);
});

it("preserves a timeout error and observes a late source rejection", async () => {
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

it("cancels a pending wait with the canonical abort error", async () => {
  const supervisor = new RetrySupervisor({ initialMs: 100, maxMs: 100, factor: 2, jitter: 0 });
  const retry = supervisor.next();
  assert(retry, "expected a retry");
  const wait = sleepWithAbort(retry.delayMs, retry.signal);
  expectTimers(retry.signal, 1);
  const reason = new Error("stop");
  supervisor.cancel(reason);
  const expected = { name: "AbortError", message: "aborted", cause: reason };
  await expect(wait).rejects.toMatchObject(expected);
  expectTimers(retry.signal);
});

it.each([
  [0, 0, 100, 250, 0.5, 100],
  [1, 0, 100, 250, 0.5, 100],
  [2, 1, 100, 250, 0.5, 250],
  [2, 1, 100, 450, 0.5, 300],
  [1_016, 0, 1_000, 30_000, 0, 30_000],
])("backoff case %#", (attempt, draw, initialMs, maxMs, jitter, expected) => {
  vi.spyOn(Math, "random").mockReturnValue(draw);
  expect(computeBackoff({ initialMs, maxMs, factor: 2, jitter }, attempt)).toBe(expected);
});

it("uses exact capped schedules", () => {
  expect([0, 1, 2, 3, 4, 5].map((n) => computeBackoffSchedule([5, 25, 120], n))).toEqual([
    0, 5, 25, 120, 120, 120,
  ]);
});

it("returns immediately for non-positive sleep durations", async () => {
  await expect(sleepWithAbort(0, AbortSignal.abort())).resolves.toBeUndefined();
  await expect(sleepWithAbort(-5)).resolves.toBeUndefined();
});

it.each([false, true])("abort during registration=%s", async (duringRegistration) => {
  const controller = new AbortController();
  const reason = new Error("stopped");
  const { signal } = controller;
  if (duringRegistration) {
    vi.spyOn(signal, "addEventListener").mockImplementation(() => controller.abort(reason));
  } else {
    controller.abort();
  }
  const error = await expectAbortedSleep(sleepWithAbort(5, signal));
  expect(error.cause).toBe(signal.reason);
  expectTimers(signal);
});

it("removes the abort listener after the sleep completes", async () => {
  const controller = new AbortController();
  const sleeper = sleepWithAbort(50, controller.signal);
  const onSettled = vi.fn();
  void sleeper.then(onSettled);
  expectTimers(controller.signal, 1);
  await vi.advanceTimersByTimeAsync(49);
  expect(onSettled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(sleeper).resolves.toBeUndefined();
  expectTimers(controller.signal);
});

it("clamps oversized sleep durations before scheduling", async () => {
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const sleeper = sleepWithAbort(Number.MAX_SAFE_INTEGER);
  expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), TIMER_MAX_MS);
  await vi.advanceTimersByTimeAsync(TIMER_MAX_MS);
  await expect(sleeper).resolves.toBeUndefined();
});

it.each(["deadline", "sleep"])("can unref the %s timer", async (kind) => {
  vi.useRealTimers();
  const controller = new AbortController();
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  try {
    const pending =
      kind === "deadline"
        ? raceWithTimeout(Promise.resolve("done"), 60_000, () => "expired", { ref: false })
        : sleepWithAbort(60_000, controller.signal, { ref: false });
    expect(scheduled.mock.results.at(-1)?.value.hasRef()).toBe(false);
    controller.abort();
    if (kind === "deadline") {
      await expect(pending).resolves.toBe("done");
    } else {
      await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
    }
  } finally {
    controller.abort();
  }
});

it.each<[number, number, number, number, number, boolean?]>([
  [1.4, 0, 10, 0, 2],
  [1.4, 0, 10, 0.5, 2],
  [1_000, 1, 1_000, 0.5, 1_000],
  [10_000, 1, 1_000, 0.5, 500],
  [2 * TIMER_MAX_MS + 123, 0, 0, 0, 2 * TIMER_MAX_MS + 123, true],
])("Retry-After case %#", async (hint, min, max, jitter, expected, optionSleep) => {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const run = createRetryRunner(optionSleep ? {} : { sleep });
  await expect(
    run(createRetryOperation(), {
      attempts: 2,
      minDelayMs: min,
      maxDelayMs: max,
      jitter,
      random: () => 0,
      retryAfterMs: () => hint,
      ...(optionSleep ? { sleep } : {}),
    }),
  ).resolves.toBe("ok");
  expect(sleep).toHaveBeenCalledExactlyOnceWith(expected);
});

it("supports custom schedules and async retry hooks", async () => {
  const events: string[] = [];
  const operation = createRetryOperation(2);
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

it("honors full native waits, numeric clamping, and the zero-delay yield", async () => {
  const timer = vi.spyOn(globalThis, "setTimeout");
  const onRetry = vi.fn();
  const delayMs = 2 * TIMER_MAX_MS + 123;
  const fullJitter: RetryOptions = {
    ...retryOptions,
    delayMs: TIMER_MAX_MS,
    jitter: "full",
    random: () => 1,
  };
  type WaitCase = [args: [RetryOptions | number, number?], advances: number[], timers: number[]];
  const cases: WaitCase[] = [
    [
      [{ ...retryOptions, retryAfterMs: () => delayMs, onRetry }],
      [TIMER_MAX_MS, TIMER_MAX_MS, 122],
      [TIMER_MAX_MS, TIMER_MAX_MS, 123],
    ],
    [[fullJitter], [TIMER_MAX_MS], [TIMER_MAX_MS, TIMER_MAX_MS]],
    [[2, 0], [], [0]],
    [[2, 10], [], [10]],
    [[2, Infinity], [], [TIMER_MAX_MS]],
  ];
  for (const [args, advances, timers] of cases) {
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
