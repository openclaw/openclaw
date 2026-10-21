import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  isCodexAppServerStartupError,
  resolveCodexGatewayTimeoutWithGraceMs,
  resolveCodexStartupTimeoutMs,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";
import { withAbortableTimeout } from "./timeout.js";

afterEach(() => vi.useRealTimers());

it.each([
  [5, undefined, 100],
  [500, undefined, 500],
  [5, 250, 250],
  [Number.NaN, undefined, 100],
  [500, Number.NaN, 500],
  [Number.NaN, Number.NaN, 100],
  [Number.MAX_SAFE_INTEGER, undefined, MAX_TIMER_TIMEOUT_MS],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
])("resolves startup timeout=%s floor=%s", (timeoutMs, timeoutFloorMs, expected) => {
  expect(resolveCodexStartupTimeoutMs({ timeoutMs, timeoutFloorMs })).toBe(expected);
});

it.each([
  [48 * 60 * 60 * 1000, 600_000],
  [120_000, 120_000],
])("bounds turn budget %s by request timeouts", (timeoutMs, expected) => {
  expect(resolveCodexStartupTimeoutMs({ timeoutMs, requestTimeoutMs: 60_000 })).toBe(expected);
});

it.each<[number, number | undefined, number]>([
  [120_000, undefined, 130_000],
  [120_000, 500, 120_500],
  [Number.MAX_SAFE_INTEGER, undefined, MAX_TIMER_TIMEOUT_MS],
  [MAX_TIMER_TIMEOUT_MS - 100, 500, MAX_TIMER_TIMEOUT_MS],
])("caps gateway timeout=%s grace=%s", (timeoutMs, grace, expected) => {
  expect(resolveCodexGatewayTimeoutWithGraceMs(timeoutMs, grace)).toBe(expected);
});

it.each([false, true])(
  "waits for startup timeout cleanup before rejecting (cleanup aborts: %s)",
  async (abortDuringCleanup) => {
    vi.useFakeTimers();
    const events: string[] = [];
    const controller = new AbortController();
    const run = withCodexStartupTimeout({
      timeoutMs: 10,
      signal: controller.signal,
      onTimeout: async () => {
        events.push("cleanup-start");
        if (abortDuringCleanup) {
          controller.abort();
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        events.push("cleanup-done");
      },
      operation: async () => new Promise<never>(() => {}),
    });
    const errorResult = run.catch((error: unknown) => {
      events.push("rejected");
      return error;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(["cleanup-start"]);
    await vi.advanceTimersByTimeAsync(5);
    const error = await errorResult;
    expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
    expect((error as Error).message).toBe("codex app-server startup timed out");
    expect(events).toEqual(["cleanup-start", "cleanup-done", "rejected"]);
  },
);

it("rejects startup timeout when aborted before completion", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const run = withCodexStartupTimeout({
    timeoutMs: 1_000,
    signal: controller.signal,
    operation: async () => new Promise<never>(() => {}),
  });
  const errorResult = run.catch((error: unknown) => error);

  controller.abort();

  const error = await errorResult;
  expect(isCodexAppServerStartupError(error, "aborted")).toBe(true);
  expect((error as Error).message).toBe("codex app-server startup aborted");
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "keeps cancellation active with a disabled timeout of %s",
  async (timeoutMs) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("owner stopped");
    const outcome = withAbortableTimeout({
      promise: new Promise<never>(() => {}),
      signal: controller.signal,
      timeoutMs,
      timeoutMessage: "unexpected deadline",
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(reason);

    await expect(outcome).resolves.toBe(reason);
  },
);

it("honors combined request budgets beyond the native timer limit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const timeoutMs = MAX_TIMER_TIMEOUT_MS + 600_000;
  const reason = new Error("combined request budget expired");
  const settled = vi.fn();
  const outcome = withAbortableTimeout({
    promise: new Promise<never>(() => {}),
    timeoutMs,
    timeoutMessage: "unexpected deadline",
    createTimeoutError: () => reason,
  }).catch((error: unknown) => {
    settled();
    return error;
  });

  await vi.advanceTimersByTimeAsync(1);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(timeoutMs - 2);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(outcome).resolves.toBe(reason);
});
