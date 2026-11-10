import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  isCodexAppServerStartupError as isStartupError,
  resolveCodexStartupTimeoutMs as startupBudget,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";
import { withAbortableTimeout } from "./timeout.js";

afterEach(() => vi.useRealTimers());

it.each([
  [5, undefined, undefined, 100],
  [500, undefined, undefined, 500],
  [5, 250, undefined, 250],
  [Number.NaN, undefined, undefined, 100],
  [500, Number.NaN, undefined, 500],
  [Number.MAX_SAFE_INTEGER, undefined, undefined, MAX_TIMER_TIMEOUT_MS],
  [48 * 60 * 60 * 1000, undefined, 60_000, 600_000],
  [120_000, undefined, 60_000, 120_000],
])(
  "resolves startup timeout=%s floor=%s request=%s",
  (timeoutMs, timeoutFloorMs, requestTimeoutMs, expected) => {
    expect(startupBudget({ timeoutMs, timeoutFloorMs, requestTimeoutMs })).toBe(expected);
  },
);

it.each(["operation", "cleanup", "never"])(
  "settles startup after abort during %s",
  async (abortDuring) => {
    vi.useFakeTimers();
    const events: string[] = [];
    const controller = new AbortController();
    const run = withCodexStartupTimeout({
      timeoutMs: 10,
      signal: controller.signal,
      onTimeout: async () => {
        events.push("cleanup-start");
        if (abortDuring === "cleanup") {
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

    if (abortDuring === "operation") {
      controller.abort();
    } else {
      await vi.advanceTimersByTimeAsync(10);
      expect(events).toEqual(["cleanup-start"]);
      await vi.advanceTimersByTimeAsync(5);
    }
    const aborted = abortDuring === "operation";
    expect(isStartupError(await errorResult, aborted ? "aborted" : "timed_out")).toBe(true);
    expect(events).toEqual(aborted ? ["rejected"] : ["cleanup-start", "cleanup-done", "rejected"]);
  },
);

it.each([0, Number.POSITIVE_INFINITY, MAX_TIMER_TIMEOUT_MS + 600_000])(
  "honors cancellation and the full request budget %s",
  async (timeoutMs) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AbortController();
    const reason = new Error("request ended");
    const settled = vi.fn();
    const timed = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const outcome = withAbortableTimeout({
      promise: new Promise<never>(() => {}),
      signal: timed ? undefined : controller.signal,
      timeoutMs,
      timeoutMessage: "unexpected deadline",
      createTimeoutError: () => reason,
    }).catch((error: unknown) => {
      settled();
      return error;
    });

    await vi.advanceTimersByTimeAsync(timed ? timeoutMs - 1 : 1_000);
    expect(settled).not.toHaveBeenCalled();
    if (timed) {
      await vi.advanceTimersByTimeAsync(1);
    } else {
      controller.abort(reason);
    }
    await expect(outcome).resolves.toBe(reason);
  },
);
