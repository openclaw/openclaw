import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";

const POLLING_TEST_WATCHDOG_INTERVAL_MS = 30_000;
const watchdogClock = vi.hoisted((): { now: number | undefined } => ({ now: undefined }));

vi.mock("./polling-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./polling-liveness.js")>();
  return {
    ...actual,
    TelegramPollingLivenessTracker: class extends actual.TelegramPollingLivenessTracker {
      constructor() {
        super({
          now: () => watchdogClock.now ?? Date.now(),
          monotonicNow: () => watchdogClock.now ?? performance.now(),
        });
      }
    },
  };
});

export function installPollingStallWatchdogHarness(initialNow = 0) {
  watchdogClock.now = initialNow;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const watchdogs: Array<() => void> = [];
  const watchdogWaiters: Array<{
    count: number;
    resolve: (fn: () => void) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof realSetTimeout>;
  }> = [];
  const setIntervalSpy = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation((fn, delay, ...args) => {
      if (delay !== POLLING_TEST_WATCHDOG_INTERVAL_MS) {
        return realSetInterval(fn, delay, ...args);
      }
      const watchdog = () => fn(...args);
      const timer = realSetInterval(watchdog, delay);
      realClearInterval(timer);
      watchdogs.push(watchdog);
      for (let index = watchdogWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = expectDefined(watchdogWaiters[index], `watchdog waiter ${index}`);
        if (watchdogs.length < waiter.count) {
          continue;
        }
        realClearTimeout(waiter.timeout);
        watchdogWaiters.splice(index, 1);
        waiter.resolve(
          expectDefined(watchdogs[waiter.count - 1], `watchdog callback ${waiter.count}`),
        );
      }
      return timer;
    });
  // Accelerate polling stop grace only; worker admission and execution keep real deadlines.
  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((fn, delay, ...args) =>
      realSetTimeout(fn, delay === 15_000 ? 0 : delay, ...args),
    );
  const waitForWatchdogRegistration = async (count: number) => {
    const registered = watchdogs[count - 1];
    if (registered) {
      return registered;
    }
    return await new Promise<() => void>((resolve, reject) => {
      const timeout = realSetTimeout(() => {
        reject(new Error(`Timed out waiting for polling watchdog registration ${count}`));
      }, 5_000);
      watchdogWaiters.push({ count, resolve, reject, timeout });
    });
  };
  return {
    waitForWatchdog: () => waitForWatchdogRegistration(Math.max(1, watchdogs.length)),
    waitForWatchdogRegistration,
    setNow(now: number) {
      watchdogClock.now = now;
    },
    restore() {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      watchdogClock.now = undefined;
    },
  };
}
