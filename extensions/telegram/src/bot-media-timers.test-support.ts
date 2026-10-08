import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, vi, type MockInstance } from "vitest";

export async function withTelegramGetFileRetryClock(
  error: string,
  dispatch: (getFile: () => Promise<never>) => Promise<void>,
) {
  const retries = [
    { admitted: createDeferred<void>(), delayMs: 1_000 },
    { admitted: createDeferred<void>(), delayMs: 2_000 },
  ];
  let attempt = 0;
  let clockInstalled = false;
  const getFile = vi.fn(async () => {
    if (!clockInstalled) {
      // Admission stays native; the already-armed getFile deadline must still be cleared.
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldClearNativeTimers: true,
      });
      clockInstalled = true;
    }
    const retry = retries[attempt];
    attempt += 1;
    retry?.admitted.resolve();
    throw new Error(error);
  });
  const handling = Promise.resolve().then(() => dispatch(getFile));
  const settled = handling.then(
    () => false,
    () => false,
  );
  const clockErrors: unknown[] = [];
  try {
    for (const { admitted, delayMs } of retries) {
      const shouldAdvance = await Promise.race([settled, admitted.promise.then(() => true)]);
      if (!shouldAdvance) {
        break;
      }
      try {
        await vi.advanceTimersByTimeAsync(delayMs);
      } catch (clockError) {
        // Ticks consume their range before reporting callback errors; finish the remaining retry.
        clockErrors.push(clockError);
      }
    }
    await handling;
    if (clockErrors.length > 0) {
      throw new AggregateError(clockErrors, "Telegram getFile retry clock failed");
    }
    expect(getFile).toHaveBeenCalledTimes(3);
  } finally {
    // The handler owns real state work after the last retry and before clock restoration.
    await settled;
    if (clockInstalled) {
      vi.useRealTimers();
    }
  }
}

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

/** Runs held buffer timers and returns their already-admitted album work. */
export function runHeldTelegramBufferTimers(
  timers: ReadonlyArray<() => unknown>,
  enqueueSpy: MockInstance<KeyedAsyncQueue["enqueue"]>,
) {
  for (const timer of timers) {
    timer();
  }
  const work = enqueueSpy.mock.results.flatMap((queued, index) =>
    enqueueSpy.mock.calls[index]?.[0].startsWith("media:") && queued.type === "return"
      ? [Promise.resolve(queued.value)]
      : [],
  );
  expect(work).toHaveLength(timers.length);
  return work;
}

export async function flushChannelPostMediaGroup(
  setTimeoutSpy: ReturnType<typeof holdTelegramMediaTimeouts>,
  enqueueSpy: MockInstance<KeyedAsyncQueue["enqueue"]>,
  completionTimeoutMs = 75,
  delayMs = 20,
) {
  const flushTimer = resolveFlushTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  const [completion] = runHeldTelegramBufferTimers(flushTimer ? [flushTimer] : [], enqueueSpy);
  expect(completion).toBeDefined();
  await withTimeout(Promise.resolve(completion), completionTimeoutMs, {
    message: `Telegram buffered flush for the ${delayMs} ms timer did not complete`,
  });
}
