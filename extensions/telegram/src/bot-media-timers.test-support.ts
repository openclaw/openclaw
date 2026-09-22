import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, vi } from "vitest";

export function holdTelegramMediaTimeouts(delayMs: number) {
  return vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const handle = scheduleTimeout(callback, delay, ...args);
    // Only media deadlines are flushed manually; worker timers keep their
    // native scheduling and handles, including ref/unref lifecycle methods.
    if (delay === delayMs) {
      cancelTimeout(handle);
    }
    return handle;
  });
}

export function resolveFlushTimerForDelay(
  setTimeoutSpy: ReturnType<typeof holdTelegramMediaTimeouts>,
  delayMs: number,
) {
  const index = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === delayMs);
  const result = setTimeoutSpy.mock.results[index];
  if (result?.type === "return") {
    clearTimeout(result.value);
  }
  return setTimeoutSpy.mock.calls[index]?.[0];
}

export async function flushChannelPostMediaGroup(
  setTimeoutSpy: ReturnType<typeof holdTelegramMediaTimeouts>,
  completionTimeoutMs = 75,
  delayMs = 20,
) {
  const flushTimer = resolveFlushTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  const enqueueSpy = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
  let completion: Promise<unknown> | undefined;
  try {
    // These timers synchronously admit work, then discard the real queue promise.
    flushTimer?.();
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const queued = enqueueSpy.mock.results[0];
    if (queued?.type === "return") {
      completion = queued.value;
    }
  } finally {
    enqueueSpy.mockRestore();
  }
  expect(completion).toBeDefined();
  await withTimeout(Promise.resolve(completion), completionTimeoutMs, {
    message: `Telegram buffered flush for the ${delayMs} ms timer did not complete`,
  });
}
