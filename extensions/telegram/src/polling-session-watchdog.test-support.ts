import { expectDefined } from "@openclaw/normalization-core";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type Mock } from "vitest";
import type { TelegramPollingSession } from "./polling-session.js";

const POLLING_TEST_WATCHDOG_INTERVAL_MS = 30_000;
const watchdogClock = vi.hoisted((): { now: number | undefined } => ({ now: undefined }));

vi.mock("./polling-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./polling-liveness.js")>();
  return {
    ...actual,
    TelegramPollingLivenessTracker: class extends actual.TelegramPollingLivenessTracker {
      constructor() {
        super({
          monotonicNow: () => watchdogClock.now ?? performance.now(),
        });
      }
    },
  };
});

export function installPollingStallWatchdogHarness() {
  watchdogClock.now = 0;
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

type SessionOptions = ConstructorParameters<typeof TelegramPollingSession>[0];

export function registerPollingStallRestartTests({
  createPollingSession,
  createTelegramBotMock,
  makeIsolatedBot,
  sleepWithAbortMock,
}: {
  createPollingSession: (
    params: Pick<SessionOptions, "abortSignal" | "ingress"> & Partial<SessionOptions>,
  ) => TelegramPollingSession;
  createTelegramBotMock: Mock;
  makeIsolatedBot: () => unknown;
  sleepWithAbortMock: Mock;
}) {
  it.each(["same", "different"] as const)(
    "restarts isolated ingress when worker liveness stalls with a %s transport",
    async (replacementKind) => {
      const abort = new AbortController();
      const log = vi.fn();
      const setStatus = vi.fn<(patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
      using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const backoff = createDeferred<void>();
      sleepWithAbortMock.mockImplementationOnce(() => backoff.promise);
      const transport = {
        fetch: globalThis.fetch,
        sourceFetch: globalThis.fetch,
        close: vi.fn(async () => undefined),
      };
      const replacement =
        replacementKind === "same"
          ? transport
          : { ...transport, close: vi.fn(async () => undefined) };
      const releaseClose = createDeferred<void>();
      replacement.close.mockImplementation(async () => await releaseClose.promise);
      const createTelegramTransport = vi.fn(() => replacement);
      createTelegramBotMock.mockReturnValue(makeIsolatedBot());

      const { promise: firstWorkerTask, resolve: firstWorkerDone } = createDeferred<void>();
      const firstWorkerStop = vi.fn(async () => {
        firstWorkerDone?.();
      });
      let workerCycle = 0;
      const createWorker = vi.fn(() => {
        workerCycle += 1;
        if (workerCycle === 1) {
          return {
            stop: firstWorkerStop,
            task: vi.fn(async () => {
              await firstWorkerTask;
            }),
          };
        }
        return {
          stop: vi.fn(async () => undefined),
          task: vi.fn(async () => {
            expect(replacement.close).not.toHaveBeenCalled();
            abort.abort();
          }),
        };
      });
      const watchdogHarness = installPollingStallWatchdogHarness();
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        setStatus,
        telegramTransport: transport,
        createTelegramTransport,
        stallThresholdMs: 30_000,
        ingress: {
          createWorker,
          drainIntervalMs: 500,
        },
      });

      let runPromise: Promise<void> | undefined;
      try {
        let stopped = false;
        runPromise = session.runUntilAbort().then(() => {
          stopped = true;
        });
        const watchdog = await watchdogHarness.waitForWatchdog();
        watchdogHarness.setNow(31_000);
        watchdog?.();

        const disconnect = setStatus.mock.calls.at(-1)?.[0]?.lastDisconnect;
        expect(disconnect).toEqual({
          at: 1_000_000,
          error: expect.stringContaining("Polling stall"),
        });
        now.mockReturnValue(1_090_000);
        await vi.waitFor(() => expect(firstWorkerStop).toHaveBeenCalledTimes(1), { interval: 1 });
        await vi.waitFor(() => expect(sleepWithAbortMock).toHaveBeenCalledOnce(), { interval: 1 });
        expect(setStatus.mock.calls.at(-1)?.[0]).toMatchObject({
          connected: false,
          lifecycle: "recovering",
          lastDisconnect: disconnect,
        });
        backoff.resolve();
        await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2), { interval: 1 });
        await vi.waitFor(() => expect(replacement.close).toHaveBeenCalledOnce(), { interval: 1 });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        releaseClose.resolve();
        await runPromise;
        expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
        expect(createTelegramBotMock.mock.calls.at(0)?.[0]?.telegramTransport).toBe(transport);
        expect(createTelegramBotMock.mock.calls.at(1)?.[0]?.telegramTransport).toBe(replacement);
        expect(transport.close).toHaveBeenCalledOnce();
        expect(replacement.close).toHaveBeenCalledOnce();
        expect(setStatus).toHaveBeenCalledWith(
          expect.objectContaining({ lifecycle: "recovering" }),
        );

        expect(log).toHaveBeenCalledWith(expect.stringContaining("Polling stall detected"));
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            "isolated polling ingress finished reason=polling stall detected",
          ),
        );
        expect(log).not.toHaveBeenCalledWith(
          expect.stringContaining("Isolated polling ingress stop timed out"),
        );
      } finally {
        backoff.resolve();
        releaseClose.resolve();
        watchdogHarness.restore();
        abort.abort();
        await runPromise;
      }
    },
  );
}
