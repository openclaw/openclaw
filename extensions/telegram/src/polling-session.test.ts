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

let TelegramPollingSession: typeof import("./polling-session.js").TelegramPollingSession;

function makeBot() {
  return {
    api: {
      deleteWebhook: vi.fn(async () => true),
      getUpdates: vi.fn(async () => []),
      config: { use: vi.fn() },
    },
    stop: vi.fn(async () => undefined),
  };
}

describe("TelegramPollingSession", () => {
  beforeEach(async () => {
    vi.resetModules();
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
    ({ TelegramPollingSession } = await import("./polling-session.js"));
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

  it("forces a restart when polling stalls without getUpdates activity", async () => {
    const abort = new AbortController();
    const botStop = vi.fn(async () => undefined);
    const firstRunnerStop = vi.fn(async () => undefined);
    const secondRunnerStop = vi.fn(async () => undefined);
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        getUpdates: vi.fn(async () => []),
        config: { use: vi.fn() },
      },
      stop: botStop,
    };
    createTelegramBotMock.mockReturnValue(bot);

    let firstTaskResolve: (() => void) | undefined;
    const firstTask = new Promise<void>((resolve) => {
      firstTaskResolve = resolve;
    });
    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      if (cycle === 1) {
        return {
          task: () => firstTask,
          stop: async () => {
            await firstRunnerStop();
            firstTaskResolve?.();
          },
          isRunning: () => true,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: secondRunnerStop,
        isRunning: () => false,
      };
    });

    let watchdog: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
      watchdog = fn as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      void Promise.resolve().then(() => (fn as () => void)());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockImplementationOnce(() => 0)
      .mockImplementation(() => 120_001);

    const log = vi.fn();
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
    });

    try {
      const runPromise = session.runUntilAbort();
      for (let attempt = 0; attempt < 20 && !watchdog; attempt += 1) {
        await Promise.resolve();
      }
      expect(watchdog).toBeTypeOf("function");
      watchdog?.();
      await runPromise;

      expect(runMock).toHaveBeenCalledTimes(2);
      expect(firstRunnerStop).toHaveBeenCalledTimes(1);
      expect(botStop).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Polling stall detected"));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("polling stall detected"));
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it("rebuilds the transport after a stalled polling cycle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const firstBot = makeBot();
    const secondBot = makeBot();
    createTelegramBotMock.mockReturnValueOnce(firstBot).mockReturnValueOnce(secondBot);

    let firstTaskResolve: (() => void) | undefined;
    const firstTask = new Promise<void>((resolve) => {
      firstTaskResolve = resolve;
    });
    let cycle = 0;
    runMock.mockImplementation(() => {
      cycle += 1;
      if (cycle === 1) {
        return {
          task: () => firstTask,
          stop: async () => {
            firstTaskResolve?.();
          },
          isRunning: () => true,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
        isRunning: () => false,
      };
    });

    let watchdog: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
      watchdog = fn as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      void Promise.resolve().then(() => (fn as () => void)());
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockImplementationOnce(() => 0)
      .mockImplementation(() => 120_001);

    const transport1 = { fetch: globalThis.fetch, sourceFetch: globalThis.fetch };
    const transport2 = { fetch: globalThis.fetch, sourceFetch: globalThis.fetch };
    const createTelegramTransport = vi.fn(() => transport2);

    try {
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
        telegramTransport: transport1,
        createTelegramTransport,
      });

      const runPromise = session.runUntilAbort();
      for (let attempt = 0; attempt < 20 && !watchdog; attempt += 1) {
        await Promise.resolve();
      }
      watchdog?.();
      await runPromise;

      expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
      expect(createTelegramBotMock.mock.calls[0]?.[0]?.telegramTransport).toBe(transport1);
      expect(createTelegramBotMock.mock.calls[1]?.[0]?.telegramTransport).toBe(transport2);
      expect(createTelegramTransport).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rebuilds the transport after a recoverable polling error", async () => {
    const abort = new AbortController();
    const recoverableError = new Error("recoverable polling error");
    const transport1 = { fetch: globalThis.fetch, sourceFetch: globalThis.fetch };
    const transport2 = { fetch: globalThis.fetch, sourceFetch: globalThis.fetch };
    const createTelegramTransport = vi.fn(() => transport2);
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());

    let firstCycle = true;
    runMock.mockImplementation(() => {
      if (firstCycle) {
        firstCycle = false;
        return {
          task: async () => {
            throw recoverableError;
          },
          stop: vi.fn(async () => undefined),
          isRunning: () => false,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
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
      telegramTransport: transport1,
      createTelegramTransport,
    });

    await session.runUntilAbort();

    expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
    expect(createTelegramBotMock.mock.calls[0]?.[0]?.telegramTransport).toBe(transport1);
    expect(createTelegramBotMock.mock.calls[1]?.[0]?.telegramTransport).toBe(transport2);
    expect(createTelegramTransport).toHaveBeenCalledTimes(1);
  });

  it("reuses the transport after a getUpdates conflict", async () => {
    const abort = new AbortController();
    const conflictError = Object.assign(
      new Error("Conflict: terminated by other getUpdates request"),
      {
        error_code: 409,
        method: "getUpdates",
      },
    );
    const transport1 = { fetch: globalThis.fetch, sourceFetch: globalThis.fetch };
    const createTelegramTransport = vi.fn(() => ({
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
    }));
    createTelegramBotMock.mockReturnValueOnce(makeBot()).mockReturnValueOnce(makeBot());
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);

    let firstCycle = true;
    runMock.mockImplementation(() => {
      if (firstCycle) {
        firstCycle = false;
        return {
          task: async () => {
            throw conflictError;
          },
          stop: vi.fn(async () => undefined),
          isRunning: () => false,
        };
      }
      return {
        task: async () => {
          abort.abort();
        },
        stop: vi.fn(async () => undefined),
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
      telegramTransport: transport1,
      createTelegramTransport,
    });

    await session.runUntilAbort();

    expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
    expect(createTelegramBotMock.mock.calls[0]?.[0]?.telegramTransport).toBe(transport1);
    expect(createTelegramBotMock.mock.calls[1]?.[0]?.telegramTransport).toBe(transport1);
    expect(createTelegramTransport).not.toHaveBeenCalled();
  });
});
