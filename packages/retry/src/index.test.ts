import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as retry from "./index.js";

const TIMER_MAX = 2_147_000_000;
const retryOptions = { attempts: 2, minDelayMs: 0, maxDelayMs: 0 };

beforeEach(() => vi.useFakeTimers());
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

function expectTimers(signal?: AbortSignal, count = 0) {
  expect(vi.getTimerCount()).toBe(count);
  expect(signal && getEventListeners(signal, "abort").length).toBe(signal && count);
}

it.each([
  ["operation", "done"],
  ["timeout", "expired"],
  ["abort", undefined],
  ["preabort", "cancelled"],
  ["factory-error", undefined],
  ["timeout-error", undefined],
  ["source-first", "done"],
])("settles and cleans up the deadline: %s", async (mode, expected) => {
  const source = createDeferred<string>();
  const controller = new AbortController();
  const { signal } = controller;
  const failure = new Error(mode);
  if (mode === "preabort" || mode === "factory-error") {
    controller.abort(new Error("already aborted"));
  }
  const fail = () => {
    throw failure;
  };
  const operation =
    mode === "factory-error" || mode === "source-first"
      ? () => {
          expect(vi.getTimerCount()).toBe(1);
          if (mode === "factory-error") {
            return fail();
          }
          controller.abort(failure);
          return Promise.resolve("done");
        }
      : source.promise;
  const onTimeout = mode === "timeout-error" ? fail : () => "expired";
  const onAbort =
    mode === "source-first"
      ? undefined
      : mode === "preabort"
        ? () => "cancelled"
        : () => {
            throw signal.reason;
          };
  const pending = retry.raceWithTimeout(operation, 10, onTimeout, { signal, onAbort });
  const outcome = pending.catch((error: unknown) => error);
  if (mode === "operation") {
    source.resolve("done");
  } else if (mode === "timeout" || mode === "timeout-error") {
    await vi.advanceTimersByTimeAsync(10);
  } else if (mode === "abort") {
    controller.abort(failure);
  }
  expect(await outcome).toBe(expected ?? failure);
  await vi.advanceTimersByTimeAsync(0);
  expectTimers(signal);
  if (operation === source.promise) {
    source.reject(new Error("late operation rejection"));
  }
});

it("owns attempt counting, overrides, rebasing, exhaustion, and cancellation", async () => {
  const policy = { initialMs: 100, maxMs: 250, factor: 2, jitter: 0 };
  const supervisor = new retry.RetrySupervisor(policy, 2);
  expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 100 });
  supervisor.nextDelayOverrideMs = 175;
  expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 175 });
  expect(supervisor.next()).toMatchObject({ attempt: 2, delayMs: 200 });
  expect(supervisor.next()).toBeUndefined();
  expect(supervisor.attempts).toBe(3);
  supervisor.reset(25);
  const step = supervisor.next();
  assert(step, "expected a retry");
  expect(step).toMatchObject({ attempt: 1, delayMs: 25 });
  const wait = retry.sleepWithAbort(step.delayMs, step.signal);
  expectTimers(step.signal, 1);
  const reason = new Error("stop");
  supervisor.cancel(reason);
  const expected = { name: "AbortError", message: "aborted", cause: reason };
  await expect(wait).rejects.toMatchObject(expected);
  expectTimers(step.signal);
});

it.each([
  [0, 0, 100, 250, 0.5, 100],
  [2, 1, 100, 250, 0.5, 250],
  [2, 1, 100, 450, 0.5, 300],
  [1_016, 0, 1_000, 30_000, 0, 30_000],
])("backoff case %#", (attempt, draw, initialMs, maxMs, jitter, expected) => {
  vi.spyOn(Math, "random").mockReturnValue(draw);
  expect(retry.computeBackoff({ initialMs, maxMs, factor: 2, jitter }, attempt)).toBe(expected);
});

it("uses exact capped schedules", () => {
  expect([0, 1, 2, 3, 4].map((n) => retry.computeBackoffSchedule([5, 25, 120], n))).toEqual([
    0, 5, 25, 120, 120,
  ]);
});

it("returns immediately for zero sleep even when aborted", async () => {
  await expect(retry.sleepWithAbort(0, AbortSignal.abort())).resolves.toBeUndefined();
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
  const pending = retry.sleepWithAbort(5, signal);
  await expect(pending).rejects.toBeInstanceOf(Error);
  const expected = { message: "aborted", cause: signal.reason };
  await expect(pending).rejects.toMatchObject(expected);
  expectTimers(signal);
});

it.each([50, Number.MAX_SAFE_INTEGER])("completes bounded sleep %s", async (input) => {
  const signal = input === 50 ? new AbortController().signal : undefined;
  const delay = input === 50 ? 50 : TIMER_MAX;
  const sleeper = retry.sleepWithAbort(input, signal);
  const onSettled = vi.fn();
  void sleeper.then(onSettled);
  expectTimers(signal, 1);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(onSettled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(sleeper).resolves.toBeUndefined();
  expectTimers(signal);
});

it.each(["deadline", "sleep"])("can unref the %s timer", async (kind) => {
  vi.useRealTimers();
  const controller = new AbortController();
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  try {
    const pending =
      kind === "deadline"
        ? retry.raceWithTimeout(Promise.resolve("done"), 60_000, () => "expired", { ref: false })
        : retry.sleepWithAbort(60_000, controller.signal, { ref: false });
    expect(scheduled.mock.results.at(-1)?.value.hasRef()).toBe(false);
    controller.abort();
    await pending.catch(() => {});
  } finally {
    controller.abort();
  }
});

it.each([
  [1.4, 0, 10, 0, 2],
  [1.4, 0, 10, 0.5, 2],
  [1_000, 1, 1_000, 0.5, 1_000],
  [10_000, 1, 1_000, 0.5, 500],
  [500, 0, 1_000, 0, 500],
  [500, 0, 100, 0, 100],
  [50, 250, 1_000, 0, 250],
])("Retry-After case %#", async (hint, min, max, jitter, expected) => {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const run = retry.createRetryRunner({ sleep });
  const options: retry.RetryOptions = {
    attempts: 2,
    minDelayMs: min,
    maxDelayMs: max,
    jitter,
    random: () => 0,
    retryAfterMs: () => hint,
  };
  await expect(run(createRetryOperation(), options)).resolves.toBe("ok");
  expect(sleep).toHaveBeenCalledExactlyOnceWith(expected);
});

it.each<[string, number, number | retry.RetryOptions, number]>([
  ["returns on first success", 0, 3, 1],
  ["propagates after exhausting retries", 2, 2, 2],
  ["clamps attempts to at least one", 1, { ...retryOptions, attempts: 0 }, 1],
  ["defaults malformed numeric attempt counts", 3, Number.NaN, 3],
])("%s", async (_name, failures, options, expectedCalls) => {
  const operation = createRetryOperation(failures);
  const outcome = retry.retryAsync(operation, options, 1).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  expect(await outcome).toEqual(
    failures >= expectedCalls ? { error: new Error("retryable") } : { value: "ok" },
  );
  expect(operation).toHaveBeenCalledTimes(expectedCalls);
});

it("stops when shouldRetry returns false", async () => {
  const error = new Error("terminal");
  const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error);
  const shouldRetry = vi.fn(() => false);
  await expect(retry.retryAsync(operation, { attempts: 3, shouldRetry })).rejects.toBe(error);
  expect(operation).toHaveBeenCalledOnce();
  expect(shouldRetry).toHaveBeenCalledExactlyOnceWith(error, 1);
});

it("reports the failed attempt and label to onRetry", async () => {
  const error = new Error("retryable");
  const operation = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce("ok");
  const onRetry = vi.fn();
  await expect(
    retry.retryAsync(operation, { ...retryOptions, label: "telegram", onRetry }),
  ).resolves.toBe("ok");
  expect(onRetry).toHaveBeenCalledExactlyOnceWith({
    attempt: 1,
    maxAttempts: 2,
    err: error,
    label: "telegram",
    delayMs: 0,
  });
});

it.each<{
  name: string;
  draw: number;
  options?: retry.RetryOptions;
  delays: number[];
}>([
  {
    name: "exponential backoff without jitter",
    draw: 0.75,
    options: { minDelayMs: 500, jitter: 0 },
    delays: [500, 1_000],
  },
  { name: "full jitter midpoint", draw: 0.5, delays: [150, 300] },
  { name: "full jitter floor", draw: 0, delays: [100, 200] },
  { name: "full jitter ceiling", draw: 0.999, delays: [200, 400] },
  {
    name: "cap after the full-jitter draw",
    draw: 0.75,
    options: { minDelayMs: 1_000, maxDelayMs: 2_500 },
    delays: [1_750, 2_500, 2_500],
  },
  {
    name: "full jitter above the Retry-After minimum",
    draw: 0.5,
    options: { minDelayMs: 250, maxDelayMs: 1_000, retryAfterMs: () => 50 },
    delays: [375],
  },
  {
    name: "full jitter below an unsatisfiable Retry-After cap",
    draw: 0.5,
    options: { maxDelayMs: 1_000, retryAfterMs: () => 5_000 },
    delays: [750],
  },
])("preserves $name", async ({ draw, options, delays }) => {
  const operation = createRetryOperation(delays.length);
  const notified: number[] = [];
  const slept: number[] = [];
  await expect(
    retry.retryAsync(operation, {
      attempts: delays.length + 1,
      minDelayMs: 100,
      maxDelayMs: 10_000,
      jitter: "full",
      random: () => draw,
      ...options,
      onRetry: ({ delayMs }) => notified.push(delayMs),
      sleep: async (delayMs) => void slept.push(delayMs),
    }),
  ).resolves.toBe("ok");
  expect(notified).toEqual(delays);
  expect(slept).toEqual(delays);
  expect(operation).toHaveBeenCalledTimes(delays.length + 1);
});

it("supports custom schedules and async retry hooks", async () => {
  const events: string[] = [];
  const options: retry.RetryOptions = {
    attempts: 3,
    minDelayMs: 0,
    maxDelayMs: 100,
    delayMs: ({ attempt }) => [10, 30][attempt - 1] ?? 0,
    onRetry: async ({ attempt }) => void events.push(`retry:${attempt}`),
    sleep: async (ms) => void events.push(`sleep:${ms}`),
  };
  await expect(retry.retryAsync(createRetryOperation(2), options)).resolves.toBe("ok");
  expect(events).toEqual(["retry:1", "sleep:10", "retry:2", "sleep:30"]);
});

it("preserves terminal Error identity", async () => {
  const terminal = new Error("terminal");
  const operation = vi.fn<() => Promise<string>>().mockRejectedValue(terminal);
  await expect(retry.retryAsync(operation, { attempts: 1 })).rejects.toBe(terminal);
});

const longDelayMs = 2 * TIMER_MAX + 123;
it.each<[retry.RetryOptions | number, number | undefined, number]>([
  [{ ...retryOptions, retryAfterMs: () => longDelayMs }, undefined, longDelayMs],
  [
    { ...retryOptions, delayMs: TIMER_MAX, jitter: "full", random: () => 1 },
    undefined,
    2 * TIMER_MAX,
  ],
  [2, 0, 0],
  [2, Infinity, TIMER_MAX],
])("honors the full native wait: %j", async (options, initialDelay, total) => {
  const onRetry = vi.fn();
  const operation = createRetryOperation();
  const configured = typeof options === "number" ? options : { ...options, onRetry };
  const result = retry.createRetryRunner()(operation, configured, initialDelay);
  expect(operation).toHaveBeenCalledOnce();
  // One millisecond short must never start the retry, even across native timer chunks.
  await vi.advanceTimersByTimeAsync(Math.max(0, total - 1));
  expect(operation).toHaveBeenCalledTimes(total > 0 ? 1 : 2);
  await vi.advanceTimersByTimeAsync(total === 0 ? 0 : 1);
  await expect(result).resolves.toBe("ok");
  expect(operation).toHaveBeenCalledTimes(2);
  if (typeof options !== "number") {
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ delayMs: total }));
  }
});

it("keeps successive overflowed numeric waits at the safe timer ceiling", async () => {
  const operation = createRetryOperation(2);
  const result = retry.retryAsync(operation, 3, Number.MAX_VALUE);
  for (const calls of [1, 2]) {
    await vi.advanceTimersByTimeAsync(TIMER_MAX - 1);
    expect(operation).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(calls + 1);
  }
  await expect(result).resolves.toBe("ok");
});

it.each([
  {
    name: "rounds attempts and delays",
    overrides: { attempts: 2.6, minDelayMs: 10.4, maxDelayMs: 99.8, jitter: 0.4 },
    expected: { attempts: 3, minDelayMs: 10, maxDelayMs: 100, jitter: 0.4 },
  },
  {
    name: "clamps attempts, delay bounds, and negative jitter",
    overrides: { attempts: 0, minDelayMs: 250, maxDelayMs: 100, jitter: -1 },
    expected: { attempts: 1, minDelayMs: 250, maxDelayMs: 250, jitter: 0 },
  },
  {
    name: "defaults non-finite overrides and caps jitter",
    overrides: {
      attempts: Number.NaN,
      minDelayMs: Number.POSITIVE_INFINITY,
      maxDelayMs: Number.NaN,
      jitter: 2,
    },
    expected: { attempts: 3, minDelayMs: 300, maxDelayMs: 30_000, jitter: 1 },
  },
  {
    name: "caps huge delays to the safe timer range",
    overrides: { minDelayMs: 3_000_000_000, maxDelayMs: 4_000_000_000 },
    expected: { attempts: 3, minDelayMs: TIMER_MAX, maxDelayMs: TIMER_MAX, jitter: 0 },
  },
  {
    name: "preserves full jitter",
    overrides: { jitter: "full" as const },
    expected: { attempts: 3, minDelayMs: 300, maxDelayMs: 30_000, jitter: "full" },
  },
])("normalizes retry config: $name", ({ overrides, expected }) => {
  expect(retry.resolveRetryConfig(undefined, overrides)).toEqual(expected);
});

it("keeps full-jitter defaults when the override is malformed", () => {
  const defaults = { attempts: 3, minDelayMs: 300, maxDelayMs: 30_000, jitter: "full" as const };
  expect(retry.resolveRetryConfig(defaults, { jitter: Number.NaN })).toEqual(defaults);
});
