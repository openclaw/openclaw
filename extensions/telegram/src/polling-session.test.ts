import { beforeEach, describe, expect, it, vi } from "vitest";

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

const createDeferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

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
    const botStop = vi.fn(async () => undefined);
    const runnerStop = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: botStop,
    };
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

    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
    });

    await session.runUntilAbort();

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(computeBackoffMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("ignores recoverable outbound restart signals from stale poll cycles", async () => {
    const abort = new AbortController();
    const cycleCallbacks: Array<(params: { error: unknown; consecutiveFailures: number }) => void> =
      [];
    const makeBot = () => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: vi.fn(async () => undefined),
    });
    createTelegramBotMock
      .mockImplementationOnce((opts) => {
        cycleCallbacks.push(opts.onRecoverableSendChatActionNetworkFailure);
        return makeBot();
      })
      .mockImplementationOnce((opts) => {
        cycleCallbacks.push(opts.onRecoverableSendChatActionNetworkFailure);
        return makeBot();
      });

    const firstCycle = createDeferred();
    const secondCycle = createDeferred();
    let firstRunning = true;
    let secondRunning = true;
    const firstRunnerStop = vi.fn(async () => {
      firstRunning = false;
      firstCycle.resolve();
    });
    const secondRunnerStop = vi.fn(async () => {
      secondRunning = false;
      secondCycle.resolve();
    });

    runMock
      .mockImplementationOnce(() => ({
        task: () => firstCycle.promise,
        stop: firstRunnerStop,
        isRunning: () => firstRunning,
      }))
      .mockImplementationOnce(() => ({
        task: () => secondCycle.promise,
        stop: secondRunnerStop,
        isRunning: () => secondRunning,
      }));

    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
    });

    const runPromise = session.runUntilAbort();

    await vi.waitFor(() => {
      expect(cycleCallbacks).toHaveLength(1);
      expect(runMock).toHaveBeenCalledTimes(1);
    });

    cycleCallbacks[0]?.({
      error: new Error("first cycle network error"),
      consecutiveFailures: 2,
    });

    await vi.waitFor(() => {
      expect(firstRunnerStop).toHaveBeenCalled();
      expect(cycleCallbacks).toHaveLength(2);
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    cycleCallbacks[0]?.({
      error: new Error("stale cycle should not restart active runner"),
      consecutiveFailures: 3,
    });

    expect(secondRunnerStop).not.toHaveBeenCalled();

    abort.abort();
    await vi.waitFor(() => {
      expect(secondRunnerStop).toHaveBeenCalled();
    });
    await runPromise;
  });

  it("forces outbound-triggered restart when runner stop does not settle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const cycleCallbacks: Array<(params: { error: unknown; consecutiveFailures: number }) => void> =
      [];
    const makeBot = () => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: vi.fn(async () => undefined),
    });
    createTelegramBotMock
      .mockImplementationOnce((opts) => {
        cycleCallbacks.push(opts.onRecoverableSendChatActionNetworkFailure);
        return makeBot();
      })
      .mockImplementationOnce((opts) => {
        cycleCallbacks.push(opts.onRecoverableSendChatActionNetworkFailure);
        return makeBot();
      });

    const firstTask = createDeferred();
    let firstRunning = true;
    const firstRunnerStop = vi.fn(async () => {
      firstRunning = false;
      await new Promise<void>(() => undefined);
    });

    runMock
      .mockImplementationOnce(() => ({
        task: () => firstTask.promise,
        stop: firstRunnerStop,
        isRunning: () => firstRunning,
      }))
      .mockImplementationOnce(() => ({
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      }));

    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log: () => undefined,
      telegramTransport: undefined,
    });

    const runPromise = session.runUntilAbort();
    await vi.waitFor(() => {
      expect(cycleCallbacks).toHaveLength(1);
      expect(runMock).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();

    cycleCallbacks[0]?.({
      error: new Error("outbound failure"),
      consecutiveFailures: 2,
    });

    await vi.advanceTimersByTimeAsync(35_000);
    await vi.waitFor(() => {
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    firstTask.resolve();
    await runPromise;
    vi.useRealTimers();
  });

  it("logs once when poll stall threshold is clamped to safety minimum", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    createTelegramBotMock.mockReturnValue({
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: vi.fn(async () => undefined),
    });
    runMock.mockImplementation(() => ({
      task: async () => {
        abort.abort();
      },
      stop: vi.fn(async () => undefined),
      isRunning: () => false,
    }));

    const session = new TelegramPollingSession({
      token: "tok",
      config: {},
      accountId: "default",
      runtime: undefined,
      proxyFetch: undefined,
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: async () => undefined,
      log,
      telegramTransport: undefined,
      pollStallThresholdMs: 5_000,
    });

    await session.runUntilAbort();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "channels.telegram.network.pollStallThresholdMs=5000 is below minimum 60000; using 60000.",
      ),
    );
  });
});
