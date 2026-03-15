import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramPollingSession } from "./polling-session.js";

const pollingState = vi.hoisted(() => {
  type ApiMethod = "deleteWebhook" | "getUpdates";
  type ApiPayload = Record<string, unknown>;
  type ApiCall = (method: ApiMethod, payload: ApiPayload, signal?: AbortSignal) => Promise<unknown>;
  type ApiMiddleware = (
    prev: ApiCall,
    method: ApiMethod,
    payload: ApiPayload,
    signal?: AbortSignal,
  ) => Promise<unknown>;

  let abortController: AbortController | undefined;
  const middlewares: ApiMiddleware[] = [];
  const getUpdatesBase = vi.fn(async (_payload: ApiPayload) => []);
  const deleteWebhookBase = vi.fn(async (_payload: ApiPayload) => true);
  const stop = vi.fn(async () => undefined);

  const callApi = (method: ApiMethod, payload: ApiPayload, signal?: AbortSignal) => {
    const invokeBase: ApiCall = async (nextMethod, nextPayload) => {
      if (nextMethod === "getUpdates") {
        return getUpdatesBase(nextPayload);
      }
      return deleteWebhookBase(nextPayload);
    };
    const chain = middlewares.reduceRight<ApiCall>((next, middleware) => {
      return (nextMethod, nextPayload, nextSignal) =>
        middleware(next, nextMethod, nextPayload, nextSignal);
    }, invokeBase);
    return chain(method, payload, signal);
  };

  const bot = {
    api: {
      config: {
        use: vi.fn((middleware: ApiMiddleware) => {
          middlewares.push(middleware);
        }),
      },
      deleteWebhook: (payload: ApiPayload) => {
        return callApi("deleteWebhook", payload);
      },
      getUpdates: (payload: ApiPayload, signal?: AbortSignal) => {
        return callApi("getUpdates", payload, signal) as Promise<unknown[]>;
      },
    },
    stop,
  };

  let runnerTask = async () => {
    await bot.api.getUpdates({ offset: 0, limit: 1, timeout: 30 });
    abortController?.abort();
  };

  const run = vi.fn(() => ({
    task: async () => {
      await runnerTask();
    },
    stop: vi.fn(async () => undefined),
    isRunning: () => false,
  }));

  return {
    bot,
    deleteWebhookBase,
    getUpdatesBase,
    reset: () => {
      abortController = undefined;
      middlewares.length = 0;
      runnerTask = async () => {
        await bot.api.getUpdates({ offset: 0, limit: 1, timeout: 30 });
        abortController?.abort();
      };
      getUpdatesBase.mockReset().mockResolvedValue([]);
      deleteWebhookBase.mockReset().mockResolvedValue(true);
      stop.mockReset().mockResolvedValue(undefined);
      bot.api.config.use.mockClear();
      run.mockClear();
    },
    run,
    setAbortController: (controller: AbortController) => {
      abortController = controller;
    },
    setRunnerTask: (task: () => Promise<void>) => {
      runnerTask = task;
    },
  };
});

vi.mock("@grammyjs/runner", () => ({
  run: pollingState.run,
}));

vi.mock("./bot.js", () => ({
  createTelegramBot: vi.fn(() => pollingState.bot),
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => await fn()),
}));

describe("TelegramPollingSession", () => {
  beforeEach(() => {
    pollingState.reset();
  });

  it("seeds the runner's first getUpdates call from the persisted offset", async () => {
    const abort = new AbortController();
    pollingState.setAbortController(abort);
    const session = new TelegramPollingSession({
      token: "tok",
      config: undefined,
      accountId: "default",
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => 549_076_203,
      persistUpdateId: vi.fn(async () => undefined),
      log: vi.fn(),
      proxyFetch: undefined,
      runtime: undefined,
    });

    await session.runUntilAbort();

    expect(pollingState.deleteWebhookBase).toHaveBeenCalledTimes(1);
    expect(pollingState.getUpdatesBase).toHaveBeenCalledTimes(1);
    expect(pollingState.getUpdatesBase).toHaveBeenCalledWith({
      offset: 549_076_204,
      limit: 1,
      timeout: 30,
    });
  });

  it("leaves the first getUpdates call unchanged when no persisted offset exists", async () => {
    const abort = new AbortController();
    pollingState.setAbortController(abort);
    const session = new TelegramPollingSession({
      token: "tok",
      config: undefined,
      accountId: "default",
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => null,
      persistUpdateId: vi.fn(async () => undefined),
      log: vi.fn(),
      proxyFetch: undefined,
      runtime: undefined,
    });

    await session.runUntilAbort();

    expect(pollingState.getUpdatesBase).toHaveBeenCalledWith({
      offset: 0,
      limit: 1,
      timeout: 30,
    });
  });

  it("reuses the seeded offset until the first getUpdates succeeds", async () => {
    const abort = new AbortController();
    pollingState.setAbortController(abort);
    pollingState.getUpdatesBase
      .mockRejectedValueOnce(new Error("transient getUpdates failure"))
      .mockResolvedValueOnce([]);
    pollingState.setRunnerTask(async () => {
      await expect(
        pollingState.bot.api.getUpdates({ offset: 0, limit: 1, timeout: 30 }),
      ).rejects.toThrow(/transient getUpdates failure/i);
      await pollingState.bot.api.getUpdates({ offset: 0, limit: 1, timeout: 30 });
      abort.abort();
    });

    const session = new TelegramPollingSession({
      token: "tok",
      config: undefined,
      accountId: "default",
      abortSignal: abort.signal,
      runnerOptions: {},
      getLastUpdateId: () => 549_076_203,
      persistUpdateId: vi.fn(async () => undefined),
      log: vi.fn(),
      proxyFetch: undefined,
      runtime: undefined,
    });

    await session.runUntilAbort();

    expect(pollingState.getUpdatesBase).toHaveBeenCalledTimes(2);
    expect(pollingState.getUpdatesBase).toHaveBeenNthCalledWith(1, {
      offset: 549_076_204,
      limit: 1,
      timeout: 30,
    });
    expect(pollingState.getUpdatesBase).toHaveBeenNthCalledWith(2, {
      offset: 549_076_204,
      limit: 1,
      timeout: 30,
    });
  });
});
