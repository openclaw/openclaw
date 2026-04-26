import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());
const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const computeBackoffMock = vi.hoisted(() => vi.fn(() => 0));
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));
const writeTelegramInboundHeartbeatMock = vi.hoisted(() => vi.fn(async () => undefined));

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

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  computeBackoff: computeBackoffMock,
  formatDurationPrecise: vi.fn((ms: number) => `${ms}ms`),
  sleepWithAbort: sleepWithAbortMock,
}));

vi.mock("./inbound-heartbeat-store.js", () => ({
  writeTelegramInboundHeartbeat: writeTelegramInboundHeartbeatMock,
}));

let TelegramPollingSession: typeof import("./polling-session.js").TelegramPollingSession;

type TelegramApiMiddleware = (
  prev: (...args: unknown[]) => Promise<unknown>,
  method: string,
  payload: unknown,
) => Promise<unknown>;

function captureMiddleware() {
  let middleware: TelegramApiMiddleware | undefined;
  createTelegramBotMock.mockReturnValueOnce({
    api: {
      deleteWebhook: vi.fn(async () => true),
      getUpdates: vi.fn(async () => []),
      config: {
        use: vi.fn((fn: TelegramApiMiddleware) => {
          middleware = fn;
        }),
      },
    },
    stop: vi.fn(async () => undefined),
  });
  return () => middleware;
}

function mockLongRunningRunner() {
  let resolveTask: (() => void) | undefined;
  runMock.mockReturnValue({
    task: () =>
      new Promise<void>((resolve) => {
        resolveTask = resolve;
      }),
    stop: async () => {
      resolveTask?.();
    },
    isRunning: () => true,
  });
  return () => resolveTask?.();
}

function createSession(abort: AbortController, log: (l: string) => void = () => {}) {
  return new TelegramPollingSession({
    token: "8246637923:dummy-token",
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
}

describe("TelegramPollingSession inbound heartbeat", () => {
  beforeAll(async () => {
    ({ TelegramPollingSession } = await import("./polling-session.js"));
  });

  beforeEach(() => {
    runMock.mockReset();
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
    writeTelegramInboundHeartbeatMock.mockReset().mockResolvedValue(undefined);
  });

  it("emits empty_ack when getUpdates returns an empty array", async () => {
    const abort = new AbortController();
    const getMiddleware = captureMiddleware();
    const resolveTask = mockLongRunningRunner();

    const session = createSession(abort);
    const runPromise = session.runUntilAbort();
    for (let i = 0; i < 20 && !getMiddleware(); i += 1) {
      await Promise.resolve();
    }
    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf("function");

    const prev = vi.fn(async () => [] as unknown[]);
    await middleware!(prev, "getUpdates", { offset: 1, timeout: 30 });
    // heartbeat is fire-and-forget; drain microtasks so the void promise runs
    await Promise.resolve();
    await Promise.resolve();

    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledWith({
      accountId: "default",
      botToken: "8246637923:dummy-token",
      outcome: "empty_ack",
      updateCount: 0,
      lastUpdateId: null,
    });

    abort.abort();
    resolveTask();
    await runPromise;
  });

  it("emits message outcome with max update_id when getUpdates returns a batch", async () => {
    const abort = new AbortController();
    const getMiddleware = captureMiddleware();
    const resolveTask = mockLongRunningRunner();

    const session = createSession(abort);
    const runPromise = session.runUntilAbort();
    for (let i = 0; i < 20 && !getMiddleware(); i += 1) {
      await Promise.resolve();
    }
    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf("function");

    const updates = [
      { update_id: 100, message: { text: "a" } },
      { update_id: 102, message: { text: "b" } },
      { update_id: 101, message: { text: "c" } },
    ];
    const prev = vi.fn(async () => updates);
    await middleware!(prev, "getUpdates", { offset: 1, timeout: 30 });
    await Promise.resolve();
    await Promise.resolve();

    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledWith({
      accountId: "default",
      botToken: "8246637923:dummy-token",
      outcome: "message",
      updateCount: 3,
      lastUpdateId: 102,
    });

    abort.abort();
    resolveTask();
    await runPromise;
  });

  it("does not call the heartbeat writer when getUpdates throws", async () => {
    const abort = new AbortController();
    const getMiddleware = captureMiddleware();
    const resolveTask = mockLongRunningRunner();

    const session = createSession(abort);
    const runPromise = session.runUntilAbort();
    for (let i = 0; i < 20 && !getMiddleware(); i += 1) {
      await Promise.resolve();
    }
    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf("function");

    const prev = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(middleware!(prev, "getUpdates", { offset: 1, timeout: 30 })).rejects.toThrow(
      /network down/,
    );
    await Promise.resolve();

    expect(writeTelegramInboundHeartbeatMock).not.toHaveBeenCalled();

    abort.abort();
    resolveTask();
    await runPromise;
  });

  it("does not call the heartbeat writer for non-getUpdates methods", async () => {
    const abort = new AbortController();
    const getMiddleware = captureMiddleware();
    const resolveTask = mockLongRunningRunner();

    const session = createSession(abort);
    const runPromise = session.runUntilAbort();
    for (let i = 0; i < 20 && !getMiddleware(); i += 1) {
      await Promise.resolve();
    }
    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf("function");

    const prev = vi.fn(async () => ({ ok: true }));
    await middleware!(prev, "sendMessage", { chat_id: 123, text: "hi" });
    await Promise.resolve();

    expect(writeTelegramInboundHeartbeatMock).not.toHaveBeenCalled();

    abort.abort();
    resolveTask();
    await runPromise;
  });

  it("throttles heartbeat writes to at most one per 5s of poll traffic", async () => {
    const abort = new AbortController();
    const getMiddleware = captureMiddleware();
    const resolveTask = mockLongRunningRunner();

    const nowSpy = vi.spyOn(Date, "now");
    // fixed timestamps so the throttle window is deterministic
    nowSpy
      .mockReturnValueOnce(1_000_000) // session start
      .mockReturnValue(1_000_100); // all subsequent calls until we override

    const session = createSession(abort);
    const runPromise = session.runUntilAbort();
    for (let i = 0; i < 20 && !getMiddleware(); i += 1) {
      await Promise.resolve();
    }
    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf("function");

    const prev = vi.fn(async () => [] as unknown[]);
    // first empty_ack at ~t0 — should write
    await middleware!(prev, "getUpdates", { offset: 1, timeout: 30 });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledTimes(1);

    // second empty_ack inside the 5s window — should be throttled
    nowSpy.mockReturnValue(1_002_000); // +1.9s
    await middleware!(prev, "getUpdates", { offset: 1, timeout: 30 });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledTimes(1);

    // third empty_ack after the 5s window — should write again
    nowSpy.mockReturnValue(1_006_500); // +5.4s after the first
    await middleware!(prev, "getUpdates", { offset: 1, timeout: 30 });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeTelegramInboundHeartbeatMock).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
    abort.abort();
    resolveTask();
    await runPromise;
  });

  it("logs and swallows a heartbeat write failure so the poll loop keeps running", async () => {
    const abort = new AbortController();
    const getMiddleware = captureMiddleware();
    const resolveTask = mockLongRunningRunner();
    writeTelegramInboundHeartbeatMock.mockRejectedValueOnce(new Error("disk full"));

    const log = vi.fn();
    const session = createSession(abort, log);
    const runPromise = session.runUntilAbort();
    for (let i = 0; i < 20 && !getMiddleware(); i += 1) {
      await Promise.resolve();
    }
    const middleware = getMiddleware();
    expect(middleware).toBeTypeOf("function");

    const prev = vi.fn(async () => [] as unknown[]);
    const result = await middleware!(prev, "getUpdates", { offset: 1, timeout: 30 });
    expect(result).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("inbound heartbeat write failed"));

    abort.abort();
    resolveTask();
    await runPromise;
  });
});
