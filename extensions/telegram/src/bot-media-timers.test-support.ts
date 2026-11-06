import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, vi, type MockInstance } from "vitest";

export async function withTelegramGetFileRetryClock(
  error: string,
  dispatch: (getFile: () => Promise<never>) => Promise<void>,
) {
  const retries = [1_000, 2_000].map((delayMs) => ({ admitted: createDeferred<void>(), delayMs }));
  let attempt = 0;
  const getFile = vi.fn(async () => {
    if (attempt === 0) {
      // Admission stays native; the already-armed getFile deadline must still be cleared.
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldClearNativeTimers: true,
      });
    }
    retries[attempt++]?.admitted.resolve();
    throw new Error(error);
  });
  const handling = Promise.resolve().then(() => dispatch(getFile));
  const stopped = () => false;
  const settled = handling.then(stopped, stopped);
  const clockErrors: unknown[] = [];
  try {
    for (const { admitted, delayMs } of retries) {
      const shouldAdvance = await Promise.race([settled, admitted.promise.then(() => true)]);
      if (!shouldAdvance) {
        break;
      }
      // Ticks consume their range before reporting callback errors; finish the remaining retry.
      await vi.advanceTimersByTimeAsync(delayMs).catch((err: unknown) => clockErrors.push(err));
    }
    await handling;
    if (clockErrors.length > 0) {
      throw new AggregateError(clockErrors, "Telegram getFile retry clock failed");
    }
    expect(getFile).toHaveBeenCalledTimes(3);
  } finally {
    // The handler owns real state work after the last retry and before clock restoration.
    await settled;
    if (attempt > 0) {
      vi.useRealTimers();
    }
  }
}

export function holdTelegramMediaTimeouts(delayMs: number) {
  return vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    const handle = scheduleTimeout(callback, delay, ...args);
    // Hold media deadlines without changing native worker handles or ref/unref behavior.
    if (delay === delayMs) {
      cancelTimeout(handle);
    }
    return handle;
  });
}

type MediaTimers = ReturnType<typeof holdTelegramMediaTimeouts>;

export function resolveFlushTimerForDelay(setTimeoutSpy: MediaTimers, delayMs: number) {
  return setTimeoutSpy.mock.calls.findLast(([, delay]) => delay === delayMs)?.[0];
}

export function runHeldTelegramBufferTimers(
  timers: ReadonlyArray<() => unknown>,
  enqueueSpy: MockInstance<typeof enqueueKeyedTask>,
) {
  timers.forEach((timer) => timer());
  const work = enqueueSpy.mock.results.flatMap((queued, index) =>
    enqueueSpy.mock.calls[index]?.[0].key.startsWith("media:") && queued.type === "return"
      ? [Promise.resolve(queued.value)]
      : [],
  );
  expect(work).toHaveLength(timers.length);
  return work;
}

export async function flushChannelPostMediaGroup(
  setTimeoutSpy: MediaTimers,
  enqueueSpy: MockInstance<typeof enqueueKeyedTask>,
  completionTimeoutMs = 75,
  delayMs = 20,
) {
  const flushTimer = resolveFlushTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  const [completion] = runHeldTelegramBufferTimers(flushTimer ? [flushTimer] : [], enqueueSpy);
  await withTimeout(Promise.resolve(completion), completionTimeoutMs, {
    message: `Telegram buffered flush for the ${delayMs} ms timer did not complete`,
  });
}
