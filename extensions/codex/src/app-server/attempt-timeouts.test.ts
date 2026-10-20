import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  isCodexAppServerStartupError,
  resolveCodexGatewayTimeoutWithGraceMs,
  resolveCodexStartupTimeoutMs,
  withCodexStartupTimeout,
} from "./attempt-timeouts.js";

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

it("waits for startup timeout cleanup before rejecting", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const run = withCodexStartupTimeout({
    timeoutMs: 10,
    signal: new AbortController().signal,
    onTimeout: async () => {
      events.push("cleanup-start");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      events.push("cleanup-done");
    },
    operation: async () => new Promise<never>(() => {}),
  });
  const errorResult = run.catch((error: unknown) => error);

  await vi.advanceTimersByTimeAsync(10);
  expect(events).toEqual(["cleanup-start"]);
  await vi.advanceTimersByTimeAsync(5);
  const error = await errorResult;
  expect(isCodexAppServerStartupError(error, "timed_out")).toBe(true);
  expect((error as Error).message).toBe("codex app-server startup timed out");
  expect(events).toEqual(["cleanup-start", "cleanup-done"]);
});

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
