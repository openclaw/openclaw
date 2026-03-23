import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const computeBackoffMock = vi.hoisted(() => vi.fn(() => 0));
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@grammyjs/runner", () => ({
  run: runMock,
}));

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
}));

vi.mock("./network-errors.js", () => ({
  isRecoverableTelegramNetworkError: isRecoverableTelegramNetworkErrorMock,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    computeBackoff: computeBackoffMock,
    sleepWithAbort: sleepWithAbortMock,
  };
});

import { TelegramPollingSession } from "./polling-session.js";

// Constants mirroring polling-session.ts internals — keep in sync if changed.
const POLL_STALL_THRESHOLD_MS = 90_000;
const POLL_WATCHDOG_INTERVAL_MS = 30_000;

function makeBot() {
  const botStop = vi.fn(async () => undefined);
  const bot = {
    api: {
      deleteWebhook: vi.fn(async () => true),
      getUpdates: vi.fn(async () => []),
      config: { use: vi.fn() },
    },
    stop: botStop,
  };
  return { bot, botStop };
}

function makeSession(
  opts: Partial<ConstructorParameters<typeof TelegramPollingSession>[0]> & {
    abortSignal?: AbortSignal;
  } = {},
) {
  return new TelegramPollingSession({
    token: "tok",
    config: {},
    accountId: "default",
    runtime: undefined,
    proxyFetch: undefined,
    runnerOptions: {},
    getLastUpdateId: () => null,
    persistUpdateId: async () => undefined,
    log: () => undefined,
    telegramTransport: undefined,
    ...opts,
  });
}

describe("TelegramPollingSession", () => {
  beforeEach(() => {
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
  });

  it("uses backoff helpers for recoverable polling retries", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const runnerStop = vi.fn(async () => undefined);
    const { bot } = makeBot();
    createTelegramBotMock.mockReturnValue(bot);

    let firstCycle = true;
    runMock.mockImplementation(() => {
      if (firstCycle) {
        firstCycle = false;
        return {
          task: async () => {
            throw recoverableError;
          },
          stop: runnerStop,
          isRunning: () => false,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: runnerStop,
        isRunning: () => false,
      };
    });

    const session = makeSession({ abortSignal: abort.signal });

    await session.runUntilAbort();

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(computeBackoffMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  describe("polling stall watchdog", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fires when getUpdates has not been called for longer than stall threshold", async () => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const { bot } = makeBot();
      createTelegramBotMock.mockReturnValue(bot);

      const logs: string[] = [];
      let cycleCount = 0;

      runMock.mockImplementation(() => {
        cycleCount += 1;
        if (cycleCount === 1) {
          // First cycle: stall — task resolves only when stop() is called.
          let resolveTask: (() => void) | undefined;
          const taskPromise = new Promise<void>((resolve) => {
            resolveTask = resolve;
          });
          return {
            task: () => taskPromise,
            stop: vi.fn(async () => {
              resolveTask?.();
            }),
            isRunning: () => true,
          };
        }
        // Second cycle: abort immediately so the session loop exits.
        abort.abort();
        return {
          task: () => Promise.resolve(),
          stop: vi.fn(async () => undefined),
          isRunning: () => false,
        };
      });

      const session = makeSession({
        abortSignal: abort.signal,
        log: (line) => {
          logs.push(line);
        },
      });

      const runPromise = session.runUntilAbort();

      // Advance past the stall threshold + watchdog poll interval to trigger the watchdog.
      await vi.advanceTimersByTimeAsync(POLL_STALL_THRESHOLD_MS + POLL_WATCHDOG_INTERVAL_MS);

      await runPromise;

      // Watchdog must have logged the stall event.
      expect(logs.find((l) => l.includes("Polling stall detected"))).toBeTruthy();
      // The restart reason log must reference the stall.
      expect(logs.find((l) => l.includes("polling stall detected"))).toBeTruthy();
      // Two polling cycles: the stalled one and the clean abort.
      expect(cycleCount).toBe(2);
    });

    it("preserves the offset across a watchdog-triggered restart so no messages are lost", async () => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const { bot } = makeBot();

      // Track the offset each new bot instance is initialized with.
      const capturedOffsets: Array<number | null> = [];
      createTelegramBotMock.mockImplementation(
        (opts: { updateOffset?: { lastUpdateId: number | null } }) => {
          capturedOffsets.push(opts.updateOffset?.lastUpdateId ?? null);
          return bot;
        },
      );

      let lastUpdateIdStore: number | null = 42;
      let runCycleCount = 0;

      runMock.mockImplementation(() => {
        runCycleCount += 1;
        if (runCycleCount === 1) {
          // First cycle stalls until stop() is called by the watchdog.
          let resolveTask: (() => void) | undefined;
          const taskPromise = new Promise<void>((resolve) => {
            resolveTask = resolve;
          });
          return {
            task: () => taskPromise,
            stop: vi.fn(async () => {
              resolveTask?.();
            }),
            isRunning: () => true,
          };
        }
        // Second cycle: abort immediately.
        abort.abort();
        return {
          task: () => Promise.resolve(),
          stop: vi.fn(async () => undefined),
          isRunning: () => false,
        };
      });

      const session = makeSession({
        abortSignal: abort.signal,
        getLastUpdateId: () => lastUpdateIdStore,
        persistUpdateId: async (id) => {
          lastUpdateIdStore = id;
        },
        log: () => undefined,
      });

      const runPromise = session.runUntilAbort();

      await vi.advanceTimersByTimeAsync(POLL_STALL_THRESHOLD_MS + POLL_WATCHDOG_INTERVAL_MS);

      await runPromise;

      // Two bots created: one per cycle. The second must reuse the stored offset.
      expect(capturedOffsets.length).toBe(2);
      expect(capturedOffsets[1]).toBe(42);
    });
  });
});
