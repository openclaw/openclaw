import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { Bot } from "grammy";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseForTest,
  executeSqliteQuerySync,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TelegramProcessingOutcome from "./bot-processing-outcome.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { commitTelegramMessageDispatchReplay } from "./message-dispatch-dedupe.js";
import {
  directUpdate,
  failedUpdateIds,
  forumUpdate,
  openTelegramSpoolTestKysely,
  topicUpdate,
  type TestTelegramUpdate,
} from "./polling-session-spool.test-support.js";
import { installTelegramIngressQueueRuntime } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramReplyFenceForTest as resetTelegramReplyFenceForTests,
} from "./runtime.test-support.js";
import {
  TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER,
  type TelegramIngressWorkerMessage,
} from "./telegram-ingress-worker.js";
import { createTestLifetime } from "./test-lifetime.test-support.js";
import { createTelegramUpdateOffsetPersistence } from "./update-offset-persistence.js";

async function waitForTelegramTestState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return await vi.waitFor(assertion, { interval: 1 });
}

const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const computeBackoffMock = vi.hoisted(() =>
  vi.fn((_policy: { initialMs: number }, _attempt: number) => 0),
);
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async () => undefined));
const drainPendingDeliveriesMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
}));

vi.mock("./network-errors.js", () => ({
  isRecoverableTelegramNetworkError: isRecoverableTelegramNetworkErrorMock,
}));

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  drainPendingDeliveries: drainPendingDeliveriesMock,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  computeBackoff: computeBackoffMock,
  createSubsystemLogger: vi.fn(() => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      isEnabled: vi.fn(() => false),
      child: vi.fn(() => logger),
    };
    return logger;
  }),
  formatDurationPrecise: vi.fn((ms: number) => `${ms}ms`),
  sleepWithAbort: sleepWithAbortMock,
}));

let TelegramPollingSession: typeof import("./polling-session.js").TelegramPollingSession;
let listTelegramSpooledUpdateClaims: typeof import("./telegram-ingress-spool.test-support.js").listTelegramSpooledUpdateClaims;
let listTelegramSpooledUpdates: typeof import("./telegram-ingress-spool.test-support.js").listTelegramSpooledUpdates;
let writeTelegramSpooledUpdate: typeof import("./telegram-ingress-spool.test-support.js").writeTelegramSpooledUpdate;
let createTelegramSpooledReplayDeferredParticipant: typeof TelegramProcessingOutcome.createTelegramSpooledReplayDeferredParticipant;
let getTelegramSpooledReplayLifecycle: typeof TelegramProcessingOutcome.getTelegramSpooledReplayLifecycle;
type TelegramSpooledReplayDeferredParticipant =
  TelegramProcessingOutcome.TelegramSpooledReplayDeferredParticipant;
function collectDeferredParticipant(
  participants: TelegramSpooledReplayDeferredParticipant[],
  key: string,
): TelegramSpooledReplayDeferredParticipant {
  const participant = expectDefined(
    createTelegramSpooledReplayDeferredParticipant(key),
    "spooled replay participant",
  );
  participants.push(participant);
  return participant;
}

type DrainPendingDeliveriesCall = {
  drainKey: string;
  logLabel: string;
  selectEntry: (
    entry: {
      channel: string;
      accountId?: string;
      lastError?: string;
    },
    now: number,
  ) => { match: boolean; bypassBackoff: boolean };
};
type WorkerPollSuccessListener = (message: {
  type: "poll-success";
  offset: null;
  count: number;
  finishedAt: number;
}) => void;
type WorkerPollErrorListener = (message: {
  type: "poll-error";
  message: string;
  errorCode?: number;
  finishedAt: number;
}) => void;
type WorkerMessageListener = (message: TelegramIngressWorkerMessage) => void;
type TestWorkerMessage =
  | TelegramIngressWorkerMessage
  | { type: "poll-success"; finishedAt: number; count: number }
  | { type: "poll-error"; finishedAt: number; message: string };
type AsyncVoidFn = () => Promise<void>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
type IsolatedIngressOptions = NonNullable<
  ConstructorParameters<typeof TelegramPollingSession>[0]["ingress"]
>;

const POLLING_TEST_WATCHDOG_INTERVAL_MS = 30_000;

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex} to exist`);
  }
  const value = call[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function logContains(source: MockCallSource, text: string): boolean {
  return source.mock.calls.some((call) => String(call[0]).includes(text));
}

function expectLogIncludes(source: MockCallSource, text: string): void {
  expect(logContains(source, text), `Expected log to include ${text}`).toBe(true);
}

function expectLogExcludes(source: MockCallSource, text: string): void {
  expect(logContains(source, text), `Expected log not to include ${text}`).toBe(false);
}

function statusPatches(source: MockCallSource): Record<string, unknown>[] {
  return source.mock.calls.map((call, index) => {
    const patch = call[0];
    if (!patch || typeof patch !== "object") {
      throw new Error(`Expected status patch call ${index} to be an object`);
    }
    return patch as Record<string, unknown>;
  });
}

function expectPollingConnectedPatch(patch: Record<string, unknown> | undefined): void {
  if (!patch) {
    throw new Error("Expected polling connected patch");
  }
  expect(patch.connected).toBe(true);
  expect(patch.mode).toBe("polling");
}

function makeIsolatedBot(params?: {
  deleteWebhook?: () => Promise<boolean>;
  handleUpdate?: (update: { update_id?: number }) => Promise<unknown>;
  init?: AsyncVoidFn;
  stop?: AsyncVoidFn;
}) {
  return {
    api: {
      deleteWebhook: vi.fn(params?.deleteWebhook ?? (async () => true)),
      config: { use: vi.fn() },
    },
    init: vi.fn(params?.init ?? (async () => undefined)),
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "OpenClaw",
      username: "openclaw_bot",
      has_topics_enabled: false,
    } as NonNullable<ConstructorParameters<typeof TelegramPollingSession>[0]["botInfo"]>,
    handleUpdate: vi.fn(params?.handleUpdate ?? (async () => undefined)),
    stop: vi.fn(params?.stop ?? (async () => undefined)),
  };
}

function installPollingStallWatchdogHarness(dateNowSequence: readonly number[] = [0, 0]) {
  let monotonicNow = dateNowSequence[0] ?? 0;
  let watchdog: (() => void) | undefined;
  let resolveWatchdog: ((fn: () => void) => void) | undefined;
  const watchdogReady = new Promise<() => void>((resolve) => {
    resolveWatchdog = resolve;
  });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const watchdogs: Array<() => void> = [];
  const watchdogWaiters: Array<{
    count: number;
    resolve: (fn: () => void) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof realSetTimeout>;
  }> = [];
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn, delay) => {
    if (delay === POLLING_TEST_WATCHDOG_INTERVAL_MS) {
      watchdog = fn as () => void;
      watchdogs.push(watchdog);
      resolveWatchdog?.(watchdog);
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
    }
    return 1 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((fn) => realSetTimeout(fn as () => void, 0));
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timeoutId) => {
    realClearTimeout(timeoutId);
  });
  const dateNowSpy = vi.spyOn(Date, "now");
  const performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  for (const value of dateNowSequence) {
    dateNowSpy.mockImplementationOnce(() => value);
  }
  dateNowSpy.mockImplementation(() => 0);

  return {
    async waitForWatchdog() {
      if (watchdog) {
        return watchdog;
      }
      return await new Promise<() => void>((resolve, reject) => {
        const timeout = realSetTimeout(() => {
          reject(new Error("Timed out waiting for polling watchdog interval registration"));
        }, 5_000);
        watchdogReady.then(
          (fn) => {
            realClearTimeout(timeout);
            resolve(fn);
          },
          (error: unknown) => {
            realClearTimeout(timeout);
            reject(toLintErrorObject(error, "Non-Error rejection"));
          },
        );
      });
    },
    async waitForWatchdogRegistration(count: number) {
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
    },
    setNow(now: number) {
      monotonicNow = now;
      dateNowSpy.mockReset();
      dateNowSpy.mockImplementation(() => now);
    },
    restore() {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
      performanceNowSpy.mockRestore();
    },
  };
}

function expectTelegramBotTransportSequence(firstTransport: unknown, secondTransport: unknown) {
  expect(createTelegramBotMock).toHaveBeenCalledTimes(2);
  expect(createTelegramBotMock.mock.calls.at(0)?.[0]?.telegramTransport).toBe(firstTransport);
  expect(createTelegramBotMock.mock.calls.at(1)?.[0]?.telegramTransport).toBe(secondTransport);
}

function expectDrainPendingDeliveriesCall(index = 0): DrainPendingDeliveriesCall {
  const call = drainPendingDeliveriesMock.mock.calls[index]?.[0];
  if (!call || typeof call !== "object") {
    throw new Error(`Expected drainPendingDeliveries call ${index}`);
  }
  return call as DrainPendingDeliveriesCall;
}

function makeTelegramTransport() {
  return {
    fetch: globalThis.fetch,
    sourceFetch: globalThis.fetch,
    close: vi.fn(async (): Promise<void> => undefined),
  };
}

function createPollingSession(params: {
  abortSignal: AbortSignal;
  log?: (message: string) => void;
  telegramTransport?: ReturnType<typeof makeTelegramTransport>;
  createTelegramTransport?: () => ReturnType<typeof makeTelegramTransport>;
  getCommittedUpdateId?: () => number | null;
  persistUpdateId?: ConstructorParameters<typeof TelegramPollingSession>[0]["persistUpdateId"];
  stallThresholdMs?: number;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  ingress: ConstructorParameters<typeof TelegramPollingSession>[0]["ingress"];
  botInfo?: ConstructorParameters<typeof TelegramPollingSession>[0]["botInfo"];
}) {
  return new TelegramPollingSession({
    token: "tok",
    config: {},
    accountId: "default",
    runtime: undefined,
    proxyFetch: undefined,
    abortSignal: params.abortSignal,
    getCommittedUpdateId: params.getCommittedUpdateId ?? (() => null),
    persistUpdateId: params.persistUpdateId ?? (async () => undefined),
    log: params.log ?? (() => undefined),
    telegramTransport: params.telegramTransport,
    stallThresholdMs: params.stallThresholdMs,
    setStatus: params.setStatus,
    ingress: params.ingress,
    ...(params.botInfo ? { botInfo: params.botInfo } : {}),
    ...(params.createTelegramTransport
      ? { createTelegramTransport: params.createTelegramTransport }
      : {}),
  });
}

async function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function writeSpooledTestUpdates(
  stateDir: string,
  updates: readonly TestTelegramUpdate[],
): Promise<void> {
  for (const update of updates) {
    await writeTelegramSpooledUpdate({ stateDir, update });
  }
}

async function pendingUpdateIds(stateDir: string, limit: number | "all" = 100): Promise<number[]> {
  return (await listTelegramSpooledUpdates({ stateDir, limit })).map((update) => update.updateId);
}

async function withTempSpool<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createIdleIngressWorker() {
  let stopWorker: (() => void) | undefined;
  const workerDone = new Promise<void>((resolve) => {
    stopWorker = resolve;
  });
  const workerStop = vi.fn(async () => {
    stopWorker?.();
  });
  const createWorker = vi.fn(() => ({
    onMessage: vi.fn(() => () => undefined),
    stop: workerStop,
    task: vi.fn(async () => {
      await workerDone;
    }),
  }));
  return {
    createWorker,
    stop: () => stopWorker?.(),
    workerStop,
  };
}

function createListeningIngressWorker() {
  let listener: WorkerMessageListener | undefined;
  const listening = createDeferred<void>();
  const acknowledged = createDeferred<void>();
  const idle = createIdleIngressWorker();
  const ackSpooledUpdate = vi.fn(() => acknowledged.resolve());
  const createWorker = vi.fn(() => {
    const worker = idle.createWorker();
    return {
      ...worker,
      ackSpooledUpdate,
      onMessage: vi.fn((nextListener: WorkerMessageListener) => {
        listener = nextListener;
        listening.resolve();
        return () => undefined;
      }),
    };
  });
  return {
    ackSpooledUpdate,
    acknowledged: acknowledged.promise,
    createWorker,
    emit: (message: TestWorkerMessage) => listener?.(message as TelegramIngressWorkerMessage),
    hasListener: () => listener !== undefined,
    listening: listening.promise,
    stop: idle.stop,
    workerStop: idle.workerStop,
  };
}

function startIsolatedIngressSession(params: {
  abort: AbortController;
  stateDir?: string;
  handleUpdate: (update: { update_id?: number }) => Promise<void>;
  createWorker?: IsolatedIngressOptions["createWorker"];
  drainIntervalMs?: number;
  getCommittedUpdateId?: () => number | null;
  init?: AsyncVoidFn;
  log?: (message: string) => void;
  persistUpdateId?: ConstructorParameters<typeof TelegramPollingSession>[0]["persistUpdateId"];
  stop?: () => Promise<void>;
  spooledUpdateHandlerTimeoutMs?: number;
  stallThresholdMs?: number;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}) {
  const idleWorker = createIdleIngressWorker();
  const createWorker = params.createWorker ?? idleWorker.createWorker;
  const bot = makeIsolatedBot({
    handleUpdate: params.handleUpdate,
    init: params.init,
    stop: params.stop,
  });
  createTelegramBotMock.mockReturnValueOnce(bot);
  const session = createPollingSession({
    abortSignal: params.abort.signal,
    getCommittedUpdateId: params.getCommittedUpdateId,
    log: params.log,
    persistUpdateId: params.persistUpdateId,
    stallThresholdMs: params.stallThresholdMs,
    setStatus: params.setStatus,
    ingress: {
      createWorker,
      drainIntervalMs: params.drainIntervalMs ?? 10,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      ...(params.spooledUpdateHandlerTimeoutMs !== undefined
        ? { spooledUpdateHandlerTimeoutMs: params.spooledUpdateHandlerTimeoutMs }
        : {}),
    },
  });
  return {
    createWorker,
    runPromise: session.runUntilAbort(),
    stopWorker: idleWorker.stop,
  };
}

describe("TelegramPollingSession", () => {
  beforeAll(async () => {
    ({ TelegramPollingSession } = await import("./polling-session.js"));
    ({ listTelegramSpooledUpdateClaims, listTelegramSpooledUpdates, writeTelegramSpooledUpdate } =
      await import("./telegram-ingress-spool.test-support.js"));
    ({ createTelegramSpooledReplayDeferredParticipant, getTelegramSpooledReplayLifecycle } =
      await import("./bot-processing-outcome.js"));
  });

  beforeEach(() => {
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
    drainPendingDeliveriesMock.mockReset().mockResolvedValue(undefined);
    resetTelegramReplyFenceForTests();
    installTelegramIngressQueueRuntime(() =>
      path.join(os.tmpdir(), "openclaw-telegram-test-state"),
    );
  });

  afterEach(() => {
    clearTelegramRuntime();
    closeOpenClawStateDatabaseForTest();
  });

  it("does not start an isolated ingress worker when durable queue acquisition fails", async () => {
    await withTempSpool(async (stateDir) => {
      const abort = new AbortController();
      const queueOpenError = new Error("Telegram ingress queue could not be opened");
      const transport = makeTelegramTransport();
      const bot = makeIsolatedBot();
      createTelegramBotMock.mockReturnValueOnce(bot);
      installTelegramIngressQueueRuntime(() => stateDir, queueOpenError);

      const { createWorker } = createIdleIngressWorker();
      const session = createPollingSession({
        abortSignal: abort.signal,
        telegramTransport: transport,
        ingress: {
          stateDir,
          createWorker,
        },
      });

      try {
        await expect(session.runUntilAbort()).rejects.toBe(queueOpenError);
        expect(bot.api.deleteWebhook).toHaveBeenCalledTimes(1);
        expect(transport.close).toHaveBeenCalledTimes(1);
        expect(createWorker).not.toHaveBeenCalled();
      } finally {
        abort.abort();
      }
    });
  });

  it("initializes the main-thread bot before draining isolated ingress spool", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => undefined);
      const init = vi.fn(async () => undefined);
      const update = directUpdate(42, 123, "hello");
      await writeTelegramSpooledUpdate({
        stateDir: tempDir,
        update,
      });

      const { createWorker, runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate,
        init,
      });
      try {
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
        await waitForTelegramTestState(async () =>
          expect(
            await listTelegramSpooledUpdateClaims({
              stateDir: tempDir,
            }),
          ).toEqual([]),
        );
      } finally {
        abort.abort();
        await runPromise;
      }

      expect(createWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          initialUpdateId: null,
          token: "tok",
        }),
      );
      expect(mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset).toEqual({
        lastUpdateId: null,
        persistenceFloorUpdateId: null,
      });
      expect(init).toHaveBeenCalledBefore(handleUpdate);
      expect(handleUpdate).toHaveBeenCalledWith(update);
    });
  });

  it.for([
    {
      name: "preserves a cached bot without making another getMe request",
      seeded: true,
      topicsEnabled: false,
      expectedGetMeCalls: 0,
      expectedLaneKey: "telegram:1234",
    },
    {
      name: "initializes an uncached bot with exactly one getMe request",
      seeded: false,
      topicsEnabled: true,
      expectedGetMeCalls: 1,
      expectedLaneKey: "telegram:1234:topic:42",
    },
  ])(
    "shares the installed grammY bot capability snapshot: $name",
    async ({ seeded, topicsEnabled, expectedGetMeCalls, expectedLaneKey }, context) => {
      await withTempSpool(async (tempDir) => {
        const abort = new AbortController();
        const worker = createListeningIngressWorker();
        const botInfo = {
          id: 123,
          is_bot: true,
          first_name: "OpenClaw",
          username: "openclaw_bot",
          has_topics_enabled: topicsEnabled,
        } as NonNullable<ConstructorParameters<typeof TelegramPollingSession>[0]["botInfo"]>;
        const bot = new Bot("tok", seeded ? { botInfo } : undefined);
        const getMe = vi.spyOn(bot.api, "getMe").mockResolvedValue(botInfo);
        vi.spyOn(bot.api, "deleteWebhook").mockResolvedValue(true);
        vi.spyOn(bot, "stop").mockResolvedValue(undefined);
        const handlerStarted = createDeferred<void>();
        const handlerCompleted = createDeferred<void>();
        const handleUpdate = vi.spyOn(bot, "handleUpdate").mockImplementation(async () => {
          handlerStarted.resolve();
          await handlerCompleted.promise;
        });
        createTelegramBotMock.mockReturnValueOnce(bot);
        const session = createPollingSession({
          abortSignal: abort.signal,
          ...(seeded ? { botInfo } : {}),
          ingress: {
            stateDir: tempDir,
            createWorker: worker.createWorker,
            drainIntervalMs: 10,
          },
        });
        const runPromise = session.runUntilAbort();
        const lifetime = createTestLifetime(context, async () => {
          handlerCompleted.resolve();
          abort.abort();
          await runPromise;
        });
        try {
          await lifetime.wait(worker.listening);
          worker.emit({
            type: "update",
            requestId: "topic-capability-1",
            update: {
              update_id: 143,
              message: {
                chat: { id: 1234, type: "private" },
                message_thread_id: 42,
                text: "installed bot capability snapshot",
              },
            },
            queued: 1,
          });
          await lifetime.wait(worker.acknowledged);
          expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("topic-capability-1", {
            ok: true,
            updateId: 143,
          });
          await lifetime.wait(handlerStarted.promise);
          expect(handleUpdate).toHaveBeenCalledOnce();
          const { database, kysely } = openTelegramSpoolTestKysely(tempDir);
          const rows = executeSqliteQuerySync(
            database.db,
            kysely
              .selectFrom("channel_ingress_events")
              .select(["lane_key", "status"])
              .where("event_id", "=", String(143).padStart(16, "0")),
          ).rows;
          expect(rows).toMatchObject([{ lane_key: expectedLaneKey, status: "claimed" }]);
          expect(getMe).toHaveBeenCalledTimes(expectedGetMeCalls);
          expect(bot.botInfo).toBe(botInfo);
        } finally {
          await lifetime.close();
        }
      });
    },
  );

  it("spools, persists the actual update id, then acknowledges", async (context) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const persistUpdateId = vi.fn(async (updateId: number) => {
        expect(updateId).toBe(42);
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([42]);
      });
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate: vi.fn(async () => undefined),
        createWorker: worker.createWorker,
        drainIntervalMs: 60_000,
        getCommittedUpdateId: () => 40,
        persistUpdateId,
      });
      const lifetime = createTestLifetime(context, async () => {
        abort.abort();
        await runPromise;
      });
      try {
        await lifetime.wait(worker.listening);
        const update = directUpdate(42, 123, "hello");
        worker.emit({
          type: "update",
          requestId: "offset-gap",
          update,
          queued: 1,
        });
        await lifetime.wait(worker.acknowledged);
        expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("offset-gap", {
          ok: true,
          updateId: 42,
        });
        expect(
          expectDefined(persistUpdateId.mock.invocationCallOrder[0], "offset persistence order"),
        ).toBeLessThan(
          expectDefined(worker.ackSpooledUpdate.mock.invocationCallOrder[0], "worker ack order"),
        );
      } finally {
        await lifetime.close();
      }
    });
  });

  it("acknowledges a durable update when offset persistence fails", async (context) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const log = vi.fn();
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate: vi.fn(async () => undefined),
        createWorker: worker.createWorker,
        log,
        persistUpdateId: vi.fn(async () => {
          throw new Error("offset store unavailable");
        }),
      });
      const lifetime = createTestLifetime(context, async () => {
        abort.abort();
        await runPromise;
      });
      try {
        await lifetime.wait(worker.listening);
        const update = directUpdate(43, 123, "hello");
        worker.emit({
          type: "update",
          requestId: "offset-failure",
          update,
          queued: 1,
        });
        await lifetime.wait(worker.acknowledged);
        expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("offset-failure", {
          ok: true,
          updateId: 43,
        });
        expectLogIncludes(log, "isolated polling offset persist failed updateId=43");
      } finally {
        await lifetime.close();
      }
    });
  });

  it("keeps isolated intake moving while the durable offset catches up", async (context) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const offsetWrite = createDeferred<void>();
      let offsetPersisted = false;
      const persistUpdateId = vi.fn(async () => {
        await offsetWrite.promise;
        offsetPersisted = true;
      });
      const handled = createDeferred<void>();
      const handleUpdate = vi.fn(async () => handled.resolve());
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
        persistUpdateId,
      });
      const lifetime = createTestLifetime(context, async () => {
        offsetWrite.resolve();
        abort.abort();
        await runPromise;
      });
      try {
        await lifetime.wait(worker.listening);
        const update = directUpdate(44, 123, "hello");
        worker.emit({
          type: "update",
          requestId: "offset-catching-up",
          update,
          queued: 1,
        });
        await lifetime.wait(worker.acknowledged);
        expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("offset-catching-up", {
          ok: true,
          updateId: 44,
        });
        expect(persistUpdateId).toHaveBeenCalledWith(44);
        expect(offsetPersisted).toBe(false);
        await lifetime.wait(handled.promise);
        expect(handleUpdate).toHaveBeenCalledOnce();
        expect(offsetPersisted).toBe(false);
      } finally {
        await lifetime.close();
      }
    });
  });

  it("recovers offset persistence and suppresses restart replay", async (context) => {
    await withTempSpool(async (tempDir) => {
      let durableUpdateId = 40;
      const writeUpdateId = vi
        .fn(async (updateId: number) => {
          durableUpdateId = updateId;
        })
        .mockRejectedValueOnce(new Error("offset store unavailable"));
      const firstOffsetPersistence = createTelegramUpdateOffsetPersistence({
        initialUpdateId: durableUpdateId,
        writeUpdateId,
        onInvalidUpdateId: vi.fn(),
        onRetry: vi.fn(),
      });
      const handleUpdate = vi.fn(async () => undefined);
      const firstAbort = new AbortController();
      const firstWorker = createListeningIngressWorker();
      const firstSession = startIsolatedIngressSession({
        abort: firstAbort,
        stateDir: tempDir,
        handleUpdate,
        createWorker: firstWorker.createWorker,
        getCommittedUpdateId: firstOffsetPersistence.getCommittedUpdateId,
        persistUpdateId: firstOffsetPersistence.persistUpdateId,
      });
      const update = directUpdate(42, 123, "hello");
      const firstLifetime = createTestLifetime(context, async () => {
        firstAbort.abort();
        await firstSession.runPromise;
        await firstOffsetPersistence.stop();
      });
      try {
        await firstLifetime.wait(firstWorker.listening);
        firstWorker.emit({
          type: "update",
          requestId: "first-delivery",
          update,
          queued: 1,
        });
        await firstLifetime.wait(firstWorker.acknowledged);
        expect(firstWorker.ackSpooledUpdate).toHaveBeenCalledWith("first-delivery", {
          ok: true,
          updateId: 42,
        });
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledOnce());
        await waitForTelegramTestState(() =>
          expect(firstOffsetPersistence.getCommittedUpdateId()).toBe(42),
        );
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        await firstLifetime.close();
      }

      expect(writeUpdateId).toHaveBeenCalledTimes(2);
      expect(durableUpdateId).toBe(42);

      const restartWriteUpdateId = vi.fn(async () => undefined);
      const restartedOffsetPersistence = createTelegramUpdateOffsetPersistence({
        initialUpdateId: durableUpdateId,
        writeUpdateId: restartWriteUpdateId,
        onInvalidUpdateId: vi.fn(),
        onRetry: vi.fn(),
      });
      const restartAbort = new AbortController();
      const restartWorker = createListeningIngressWorker();
      const restartedSession = startIsolatedIngressSession({
        abort: restartAbort,
        stateDir: tempDir,
        handleUpdate,
        createWorker: restartWorker.createWorker,
        getCommittedUpdateId: restartedOffsetPersistence.getCommittedUpdateId,
        persistUpdateId: restartedOffsetPersistence.persistUpdateId,
      });
      const restartedLifetime = createTestLifetime(context, async () => {
        restartAbort.abort();
        await restartedSession.runPromise;
        await restartedOffsetPersistence.stop();
      });
      try {
        await restartedLifetime.wait(restartWorker.listening);
        restartWorker.emit({
          type: "update",
          requestId: "restart-replay",
          update,
          queued: 1,
        });
        await restartedLifetime.wait(restartWorker.acknowledged);
        expect(restartWorker.ackSpooledUpdate).toHaveBeenCalledWith("restart-replay", {
          ok: true,
          updateId: 42,
        });
        expect(handleUpdate).toHaveBeenCalledOnce();
        expect(restartWriteUpdateId).not.toHaveBeenCalled();
      } finally {
        await restartedLifetime.close();
      }
    });
  });

  it("does not persist or acknowledge success when spooling fails", async (context) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const persistUpdateId = vi.fn(async () => undefined);
      const worker = createListeningIngressWorker();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate: vi.fn(async () => undefined),
        createWorker: worker.createWorker,
        persistUpdateId,
      });
      const lifetime = createTestLifetime(context, async () => {
        abort.abort();
        await runPromise;
      });
      try {
        await lifetime.wait(worker.listening);
        worker.emit({
          type: "update",
          requestId: "spool-failure",
          update: { message: { text: "missing update id" } },
          queued: 1,
        });
        await lifetime.wait(worker.acknowledged);
        expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("spool-failure", {
          ok: false,
          message: "Telegram update missing numeric update_id.",
        });
        expect(persistUpdateId).not.toHaveBeenCalled();
      } finally {
        await lifetime.close();
      }
    });
  });

  it("drains worker-spooled updates without waiting for the next drain interval", async (context) => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => abort.abort());
      const worker = createListeningIngressWorker();
      const update = directUpdate(42, 123, "hello");
      const { runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
        drainIntervalMs: 60_000,
      });
      const lifetime = createTestLifetime(context, async () => {
        abort.abort();
        await runPromise;
      });
      try {
        await lifetime.wait(worker.listening);
        worker.emit({
          type: "update",
          requestId: "write-1",
          update,
          queued: 1,
        });
        await lifetime.wait(worker.acknowledged);
        expect(worker.ackSpooledUpdate).toHaveBeenCalledWith("write-1", {
          ok: true,
          updateId: 42,
        });
        worker.emit({ type: "spooled", updateId: 42, queued: 1 });
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledWith(update));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        await lifetime.close();
      }
    });
  });

  it("drains existing isolated ingress spool entries below the persisted offset", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => undefined);
      const update = directUpdate(42, 123, "pre-upgrade pending");
      await writeTelegramSpooledUpdate({
        stateDir: tempDir,
        update,
      });

      const { createWorker, runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate,
        getCommittedUpdateId: () => 42,
      });
      try {
        await waitForTelegramTestState(() => expect(handleUpdate).toHaveBeenCalledTimes(1));
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
        await waitForTelegramTestState(async () =>
          expect(
            await listTelegramSpooledUpdateClaims({
              stateDir: tempDir,
            }),
          ).toEqual([]),
        );
      } finally {
        abort.abort();
        await runPromise;
      }

      expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ initialUpdateId: 42 }));
      expect(mockObjectArg(createTelegramBotMock, "createTelegramBot").updateOffset).toEqual({
        lastUpdateId: null,
        persistenceFloorUpdateId: 42,
      });
      expect(handleUpdate).toHaveBeenCalledWith(update);
    });
  });

  it("drains Telegram delivery queue after isolated ingress reports poll success", async () => {
    const abort = new AbortController();
    const init = vi.fn(async () => undefined);
    const status: Partial<ChannelAccountSnapshot> = {
      connected: true,
      lastConnectedAt: 1,
      lastEventAt: 2,
      lastTransportActivityAt: 3,
      terminalDisconnect: true,
      lastError: "stale failure",
    };
    const setStatus = vi.fn((patch: Partial<ChannelAccountSnapshot>) =>
      Object.assign(status, patch),
    );
    const worker = createListeningIngressWorker();
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      init,
      setStatus,
      createWorker: worker.createWorker,
    });

    await waitForTelegramTestState(() => expect(init).toHaveBeenCalledTimes(1));
    expect(status).toMatchObject({
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastTransportActivityAt: null,
    });
    worker.emit({ type: "poll-success", finishedAt: 10_000, count: 0 });
    worker.emit({ type: "poll-success", finishedAt: 10_001, count: 0 });

    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(1),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    worker.emit({ type: "poll-success", finishedAt: 15_000, count: 0 });
    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(2),
    );
    worker.emit({ type: "poll-error", finishedAt: 15_001, message: "offline" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    worker.emit({ type: "poll-success", finishedAt: 15_002, count: 0 });
    await waitForTelegramTestState(() =>
      expect(drainPendingDeliveriesMock).toHaveBeenCalledTimes(3),
    );

    const connected = statusPatches(setStatus).find((patch) => patch.connected === true);
    expectPollingConnectedPatch(connected);
    expect(connected).toMatchObject({
      lastConnectedAt: 10_000,
      lastEventAt: 10_000,
      lastTransportActivityAt: 10_000,
      lifecycle: "ready",
      running: true,
    });
    expect(status).toMatchObject({
      running: true,
      connected: true,
      terminalDisconnect: undefined,
      lastError: null,
      lastEventAt: 15_002,
    });
    const drain = expectDrainPendingDeliveriesCall();
    expect(drain.drainKey).toBe("telegram:default");
    expect(drain.selectEntry({ channel: "telegram", accountId: "default" }, Date.now())).toEqual({
      match: true,
      bypassBackoff: false,
    });
    expect(drain.selectEntry({ channel: "telegram", accountId: "alerts" }, Date.now()).match).toBe(
      false,
    );
    expect(drain.selectEntry({ channel: "whatsapp" }, Date.now()).match).toBe(false);
    abort.abort();
    await runPromise;
    expect(statusPatches(setStatus).at(-1)).toEqual({ mode: "polling", connected: false });
  });

  it("resets restart backoff after isolated ingress reports poll success", async () => {
    const abort = new AbortController();
    const init = vi.fn(async () => undefined);
    createTelegramBotMock.mockReturnValue(makeIsolatedBot({ init }));
    sleepWithAbortMock.mockImplementation(async () => {
      if (sleepWithAbortMock.mock.calls.length >= 2) {
        abort.abort();
      }
    });

    let cycle = 0;
    const createWorker = vi.fn(() => {
      let onMessage: WorkerPollSuccessListener | undefined;
      cycle += 1;
      return {
        onMessage: vi.fn((handler) => {
          onMessage = handler;
          return () => undefined;
        }),
        stop: vi.fn(async () => undefined),
        task: vi.fn(async () => {
          if (cycle === 2) {
            onMessage?.({
              type: "poll-success",
              offset: null,
              finishedAt: Date.now(),
              count: 0,
            });
          }
        }),
      };
    });

    const session = createPollingSession({
      abortSignal: abort.signal,
      ingress: {
        createWorker,
        drainIntervalMs: 10,
      },
    });

    await session.runUntilAbort();

    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(computeBackoffMock.mock.calls.map((call) => call[1])).toEqual([1, 1]);
  });

  it("keeps a real polling worker alive during Telegram's server-directed flood wait", async () => {
    await withTempSpool(async (stateDir) => {
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.writeHead(429, { connection: "close", "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 180",
            parameters: { retry_after: 180 },
          }),
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a real loopback Bot API listener");
      }

      const abort = new AbortController();
      const log = vi.fn();
      const watchdogHarness = installPollingStallWatchdogHarness([0]);
      createTelegramBotMock.mockReturnValue(makeIsolatedBot());
      let actualWorker: Worker | undefined;
      let reportPollError: ((message: TelegramIngressWorkerMessage) => void) | undefined;
      const pollErrorReceived = new Promise<TelegramIngressWorkerMessage>((resolve) => {
        reportPollError = resolve;
      });
      const workerStop = vi.fn(async () => {
        if (actualWorker) {
          Reflect.apply(
            Reflect.get(actualWorker, "postMessage") as (message: unknown) => void,
            actualWorker,
            [{ type: "stop" }],
          );
          await actualWorker.terminate();
        }
      });
      const createWorker = vi.fn(() => {
        const worker = new Worker(
          new URL("../../../dist/telegram-ingress-worker.runtime.js", import.meta.url),
          {
            workerData: {
              runtime: TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER,
              token: "tok",
              accountId: "default",
              initialUpdateId: null,
              apiRoot: `http://127.0.0.1:${address.port}`,
              timeoutSeconds: 1,
            },
          },
        );
        actualWorker = worker;
        const task = new Promise<void>((resolve, reject) => {
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Telegram test worker exited with code ${code}`));
            }
          });
        });
        return {
          onMessage: vi.fn((listener: WorkerMessageListener) => {
            const forwardMessage = (message: TelegramIngressWorkerMessage) => {
              listener(message);
              if (message.type === "poll-error") {
                reportPollError?.(message);
              }
            };
            worker.on("message", forwardMessage);
            return () => worker.off("message", forwardMessage);
          }),
          stop: workerStop,
          task: () => task,
        };
      });
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        ingress: {
          createWorker,
          stateDir,
        },
      });
      const runPromise = session.runUntilAbort();

      try {
        const watchdog = await watchdogHarness.waitForWatchdog();
        const pollError = await pollErrorReceived;
        expect(pollError).toMatchObject({ type: "poll-error", errorCode: 429 });
        expect(requestCount).toBe(1);

        for (const elapsedMs of [30_000, 60_000, 90_000, 120_000, 150_000]) {
          watchdogHarness.setNow(elapsedMs);
          watchdog();
        }

        expect(workerStop).not.toHaveBeenCalled();
        expect(createWorker).toHaveBeenCalledTimes(1);
        expect(pollError).toMatchObject({ retryAfterMs: 180_000 });
        expectLogExcludes(log, "Polling stall detected");
      } finally {
        abort.abort();
        await runPromise.catch(() => undefined);
        await actualWorker?.terminate();
        watchdogHarness.restore();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    });
  });

  it("caps an untrusted Telegram flood wait at the existing maximum polling threshold", async () => {
    const abort = new AbortController();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      createWorker: worker.createWorker,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({
        type: "poll-error",
        errorCode: 429,
        message: "Too Many Requests",
        finishedAt: 0,
        retryAfterMs: Number.MAX_VALUE,
      });

      for (let elapsedMs = 30_000; elapsedMs <= 600_000; elapsedMs += 30_000) {
        watchdogHarness.setNow(elapsedMs);
        watchdog();
        expect(worker.workerStop).not.toHaveBeenCalled();
      }

      watchdogHarness.setNow(630_000);
      watchdog();
      expect(worker.workerStop).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await runPromise;
      watchdogHarness.restore();
    }
  });

  it.each([
    { name: "missing flood wait", errorCode: 429, retryAfterMs: undefined },
    { name: "negative flood wait", errorCode: 429, retryAfterMs: -1 },
    { name: "zero flood wait", errorCode: 429, retryAfterMs: 0 },
    { name: "non-finite flood wait", errorCode: 429, retryAfterMs: Number.POSITIVE_INFINITY },
    { name: "server error", errorCode: 502, retryAfterMs: 180_000 },
    { name: "unauthorized bot", errorCode: 401, retryAfterMs: 180_000 },
    { name: "missing bot", errorCode: 404, retryAfterMs: 180_000 },
    { name: "webhook conflict", errorCode: 409, retryAfterMs: 180_000 },
  ])("does not disable the polling watchdog for $name", async ({ errorCode, retryAfterMs }) => {
    const abort = new AbortController();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      createWorker: worker.createWorker,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({
        type: "poll-error",
        errorCode,
        message: "Telegram polling error",
        finishedAt: 0,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });

      watchdogHarness.setNow(150_000);
      watchdog();
      expect(worker.workerStop).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await runPromise;
      watchdogHarness.restore();
    }
  });

  it("restores hung-poll detection when a new request ends a Telegram flood wait", async () => {
    const abort = new AbortController();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      createWorker: worker.createWorker,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({
        type: "poll-error",
        errorCode: 429,
        message: "Too Many Requests",
        finishedAt: 0,
        retryAfterMs: 180_000,
      });

      watchdogHarness.setNow(150_000);
      watchdog();
      expect(worker.workerStop).not.toHaveBeenCalled();

      worker.emit({ type: "poll-start", offset: null, startedAt: 150_000 });
      watchdogHarness.setNow(300_001);
      watchdog();
      expect(worker.workerStop).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await runPromise;
      watchdogHarness.restore();
    }
  });

  it.each(["same", "different"] as const)(
    "restarts isolated ingress when worker liveness stalls with a %s transport",
    async (replacementKind) => {
      const abort = new AbortController();
      const log = vi.fn();
      const setStatus = vi.fn();
      const transport = makeTelegramTransport();
      const replacement = replacementKind === "same" ? transport : makeTelegramTransport();
      const releaseClose = createDeferred<void>();
      replacement.close.mockImplementation(async () => await releaseClose.promise);
      const createTelegramTransport = vi.fn(() => replacement);
      createTelegramBotMock.mockReturnValue(makeIsolatedBot());

      let firstWorkerDone: (() => void) | undefined;
      const firstWorkerTask = new Promise<void>((resolve) => {
        firstWorkerDone = resolve;
      });
      const firstWorkerStop = vi.fn(async () => {
        firstWorkerDone?.();
      });
      let workerCycle = 0;
      const createWorker = vi.fn(() => {
        workerCycle += 1;
        if (workerCycle === 1) {
          return {
            onMessage: vi.fn(() => () => undefined),
            stop: firstWorkerStop,
            task: vi.fn(async () => {
              await firstWorkerTask;
            }),
          };
        }
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: vi.fn(async () => undefined),
          task: vi.fn(async () => {
            expect(replacement.close).not.toHaveBeenCalled();
            abort.abort();
          }),
        };
      });
      const watchdogHarness = installPollingStallWatchdogHarness([0]);
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

      try {
        let stopped = false;
        const runPromise = session.runUntilAbort().then(() => {
          stopped = true;
        });
        const watchdog = await watchdogHarness.waitForWatchdog();
        watchdogHarness.setNow(31_000);
        watchdog?.();

        await waitForTelegramTestState(() => expect(firstWorkerStop).toHaveBeenCalledTimes(1));
        await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));
        await waitForTelegramTestState(() => expect(replacement.close).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        releaseClose.resolve();
        await runPromise;
        expectTelegramBotTransportSequence(transport, replacement);
        expect(transport.close).toHaveBeenCalledOnce();
        expect(replacement.close).toHaveBeenCalledOnce();
        expect(statusPatches(setStatus).some((patch) => patch.lifecycle === "recovering")).toBe(
          true,
        );

        expectLogIncludes(log, "Polling stall detected");
        expectLogIncludes(log, "isolated polling ingress finished reason=polling stall detected");
        expectLogExcludes(log, "Isolated polling ingress stop timed out");
      } finally {
        releaseClose.resolve();
        watchdogHarness.restore();
        abort.abort();
      }
    },
  );

  it("applies stop-timeout cooldown to isolated ingress forced restarts", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    createTelegramBotMock.mockReturnValue(makeIsolatedBot());
    computeBackoffMock.mockImplementation((policy: { initialMs: number }, attempt: number) => {
      if (policy.initialMs === 120_000) {
        return attempt * 100_000;
      }
      return attempt * 1_000;
    });

    const finishStoppedWorkers: Array<() => void> = [];
    let workerCycle = 0;
    const createWorker = vi.fn(() => {
      workerCycle += 1;
      if (workerCycle <= 2) {
        let finishTask: (() => void) | undefined;
        const task = new Promise<void>((resolve) => {
          finishTask = resolve;
        });
        let finishStop: (() => void) | undefined;
        const stop = new Promise<void>((resolve) => {
          finishStop = resolve;
        });
        finishStoppedWorkers.push(() => {
          finishStop?.();
          finishTask?.();
        });
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: vi.fn(() => stop),
          task: vi.fn(async () => {
            await task;
          }),
        };
      }
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => undefined),
        task: vi.fn(async () => {
          abort.abort();
        }),
      };
    });
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      stallThresholdMs: 30_000,
      ingress: {
        createWorker,
        drainIntervalMs: 500,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      const firstWatchdog = await watchdogHarness.waitForWatchdog();
      watchdogHarness.setNow(31_000);
      firstWatchdog?.();
      await waitForTelegramTestState(() =>
        expectLogIncludes(log, "Isolated polling ingress stop timed out"),
      );
      finishStoppedWorkers.shift()?.();
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));

      const secondWatchdog = await watchdogHarness.waitForWatchdogRegistration(2);
      watchdogHarness.setNow(62_000);
      secondWatchdog?.();
      await waitForTelegramTestState(() =>
        expectLogIncludes(log, "Stop timeout burst=2; applying cooldown."),
      );
      finishStoppedWorkers.shift()?.();
      await runPromise;

      const stopCooldownCalls = computeBackoffMock.mock.calls.filter(
        ([policy]) => (policy as { initialMs: number }).initialMs === 120_000,
      );
      expect(stopCooldownCalls.map((call) => call[1])).toEqual([1]);
    } finally {
      watchdogHarness.restore();
      abort.abort();
    }
  });

  it("keeps isolated ingress alive when spooled messages show worker activity", async () => {
    const abort = new AbortController();
    const log = vi.fn();
    const worker = createListeningIngressWorker();
    const watchdogHarness = installPollingStallWatchdogHarness([0]);
    const { runPromise } = startIsolatedIngressSession({
      abort,
      handleUpdate: async () => undefined,
      log,
      stallThresholdMs: 30_000,
      createWorker: worker.createWorker,
      drainIntervalMs: 500,
    });

    try {
      const watchdog = await watchdogHarness.waitForWatchdog();
      worker.emit({ type: "poll-start", offset: null, startedAt: 0 });
      watchdogHarness.setNow(31_000);
      worker.emit({ type: "spooled", updateId: 42, queued: 1 });
      watchdogHarness.setNow(45_000);
      watchdog?.();

      expect(worker.workerStop).not.toHaveBeenCalled();
      expectLogExcludes(log, "Polling stall detected");
      expectLogExcludes(log, "isolated polling worker poll-start");
    } finally {
      watchdogHarness.restore();
      abort.abort();
      await runPromise;
    }
  });

  it("lets isolated ingress control updates bypass an active spooled turn", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const events: string[] = [];
      let releaseRegularTurn: (() => void) | undefined;
      const regularTurnDone = new Promise<void>((resolve) => {
        releaseRegularTurn = resolve;
      });
      await writeSpooledTestUpdates(tempDir, [forumUpdate(42, "summarize this")]);
      const { runPromise, stopWorker } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate: async (update) => {
          if (update.update_id === 42) {
            events.push("regular:start");
            await regularTurnDone;
            events.push("regular:end");
          } else if (update.update_id === 43) {
            events.push("status");
          } else if (update.update_id === 44) {
            events.push("stop");
          }
        },
      });

      try {
        await waitForTelegramTestState(() => expect(events).toEqual(["regular:start"]));
        await writeSpooledTestUpdates(tempDir, [
          forumUpdate(43, "/status"),
          forumUpdate(44, "/stop@vacs_tars_bot"),
        ]);
        await waitForTelegramTestState(() =>
          expect(events).toEqual(["regular:start", "status", "stop"]),
        );
        expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
        releaseRegularTurn?.();
        await waitForTelegramTestState(async () =>
          expect(await pendingUpdateIds(tempDir, "all")).toEqual([]),
        );
      } finally {
        releaseRegularTurn?.();
        abort.abort();
        stopWorker();
        await runPromise;
      }
    });
  });

  it.each(
    (["buffered", "inline"] as const).flatMap((admission) =>
      (["commit", "rollback"] as const).map((operation) => ({ admission, operation })),
    ),
  )(
    "joins a held $admission replay $operation beyond polling stop grace",
    async ({ admission, operation }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await withTempSpool(async (stateDir) => {
          const abort = new AbortController();
          const operationStarted = createDeferred<void>();
          const releaseOperation = createDeferred<void>();
          const stopBot = vi.fn(async () => undefined);
          const recorded = new Set<string>();
          const participants: TelegramSpooledReplayDeferredParticipant[] = [];
          let settlement: Promise<void> | undefined;
          await writeSpooledTestUpdates(stateDir, [directUpdate(42, 111, "held replay write")]);
          const { runPromise, stopWorker } = startIsolatedIngressSession({
            abort,
            stateDir,
            stop: stopBot,
            ...(admission === "buffered" && operation === "commit"
              ? { spooledUpdateHandlerTimeoutMs: 100 }
              : {}),
            handleUpdate: async () => {
              const participant = collectDeferredParticipant(participants, "held-replay-write");
              const hold = expectDefined(participant.beginSettlementHold(), "adoption hold");
              settlement = (async () => {
                try {
                  await commitTelegramMessageDispatchReplay({
                    requirePersistent: true,
                    guard: {
                      claim: async () => ({ kind: "invalid" }),
                      warmup: async () => 0,
                      forget: async (event) => {
                        operationStarted.resolve();
                        await releaseOperation.promise;
                        for (const key of "keys" in event ? (event.keys ?? []) : []) {
                          recorded.delete(key);
                        }
                        return true;
                      },
                    },
                    claims: ["first", "second"].map((key) => ({
                      keys: [key],
                      commit: async (options) => {
                        if (operation === "commit" && key === "first") {
                          operationStarted.resolve();
                          await releaseOperation.promise;
                        }
                        recorded.add(key);
                        if (operation === "rollback" && key === "second") {
                          options?.onDiskError?.(new Error("synthetic commit failure"));
                        }
                        return true;
                      },
                      release: () => undefined,
                    })),
                  });
                  hold.release("discard-pending");
                  participant.settle({ kind: "completed" });
                } catch (error) {
                  hold.release("replay-pending");
                  participant.settle({ kind: "failed-retryable", error });
                }
              })();
              if (admission === "inline") {
                await settlement;
              }
            },
          });
          let accountStopped = false;
          const accountRun = runPromise.then(() => {
            accountStopped = true;
          });
          try {
            await operationStarted.promise;
            if (admission === "buffered" && operation === "commit") {
              await vi.advanceTimersByTimeAsync(200);
              expect(participants[0]?.abortSignal.aborted).toBe(false);
              expect(
                (await listTelegramSpooledUpdateClaims({ stateDir })).map(
                  (claim) => claim.updateId,
                ),
              ).toEqual([42]);
            }
            abort.abort();
            stopWorker();
            await vi.advanceTimersByTimeAsync(16_000);
            expect(accountStopped).toBe(false);
            expect(stopBot).not.toHaveBeenCalled();
          } finally {
            releaseOperation.resolve();
            await settlement;
            abort.abort();
            stopWorker();
            await accountRun;
            await waitForTelegramTestState(async () =>
              expect(await listTelegramSpooledUpdateClaims({ stateDir })).toEqual([]),
            );
          }
          expect(stopBot).toHaveBeenCalledOnce();
          expect([...recorded]).toEqual(operation === "commit" ? ["first", "second"] : []);
          expect(await pendingUpdateIds(stateDir, "all")).toEqual(
            operation === "commit" ? [] : [42],
          );
          expect(await failedUpdateIds(stateDir)).toEqual([]);
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps an adopted reply usable across an isolated worker crash until account shutdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await withTempSpool(async (stateDir) => {
        const requests: Array<{ chat_id: number; text: string }> = [];
        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            const isReply = request.url?.endsWith("/sendMessage");
            if (isReply) {
              requests.push(JSON.parse(body));
            }
            response.writeHead(200, { connection: "close", "content-type": "application/json" });
            response.end(
              JSON.stringify({
                ok: true,
                result: isReply
                  ? {
                      message_id: 900,
                      date: 0,
                      chat: { id: -100, type: "supergroup", title: "Test group" },
                      text: "reply after worker crash",
                    }
                  : true,
              }),
            );
          });
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected a loopback Bot API listener");
        }

        const abort = new AbortController();
        const adopted = createDeferred<void>();
        const releaseReply = createDeferred<void>();
        const delivery = createDeferred<{ messageId: number } | { error: unknown }>();
        const transport = makeTelegramTransport();
        const replacementBot = makeIsolatedBot();
        let firstFetchSignal: AbortSignal | undefined;
        let firstMediaSignal: AbortSignal | undefined;
        createTelegramBotMock
          .mockImplementationOnce((opts: TelegramBotOptions) => {
            firstFetchSignal = opts.fetchAbortSignal;
            firstMediaSignal = opts.mediaAbortSignal;
            const botTransport = expectDefined(opts.telegramTransport, "polling transport");
            const clientFetch = expectDefined(
              createTelegramClientFetch({
                fetchImpl: asTelegramClientFetch(botTransport.fetch),
                shutdownSignal: opts.fetchAbortSignal,
                transport: botTransport,
              }),
              "Bot API fetch",
            );
            const bot = new Bot("tok", {
              botInfo: replacementBot.botInfo,
              client: {
                apiRoot: `http://127.0.0.1:${address.port}`,
                fetch: asTelegramClientFetch(clientFetch),
              },
            });
            vi.spyOn(bot, "stop").mockResolvedValue(undefined);
            bot.on("message", async (ctx) => {
              const lifecycle = expectDefined(
                getTelegramSpooledReplayLifecycle(),
                "replay lifecycle",
              );
              await lifecycle.onAdopted();
              adopted.resolve();
              await releaseReply.promise;
              try {
                const message = await ctx.reply("reply after worker crash");
                delivery.resolve({ messageId: message.message_id });
              } catch (error) {
                delivery.resolve({ error });
              }
            });
            return bot;
          })
          .mockReturnValue(replacementBot);
        const idleWorker = createIdleIngressWorker();
        const firstWorkerStop = vi.fn(async () => undefined);
        const createWorker = vi.fn(idleWorker.createWorker).mockImplementationOnce(() => ({
          onMessage: vi.fn(() => () => undefined),
          stop: firstWorkerStop,
          task: vi.fn(async () => {
            await adopted.promise;
            throw new Error("worker crashed after adoption");
          }),
        }));
        let runPromise: Promise<void> | undefined;
        try {
          const update = topicUpdate(42, 10, "finish after worker crash");
          await writeSpooledTestUpdates(stateDir, [update]);
          const session = createPollingSession({
            abortSignal: abort.signal,
            telegramTransport: transport,
            ingress: { stateDir, createWorker, drainIntervalMs: 100 },
          });
          runPromise = session.runUntilAbort();
          await adopted.promise;
          await waitForTelegramTestState(() => expect(firstWorkerStop).toHaveBeenCalledTimes(1));
          expect(firstMediaSignal?.aborted).toBe(true);
          expect(firstFetchSignal?.aborted).toBe(false);
          expect(await listTelegramSpooledUpdateClaims({ stateDir })).toEqual([]);
          await writeSpooledTestUpdates(stateDir, [update]);
          expect(await pendingUpdateIds(stateDir, "all")).toEqual([]);

          // The adopted handler may outlive the old ingress monitor's stop grace.
          await vi.advanceTimersByTimeAsync(20_000);
          await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(2));
          expect(transport.close).not.toHaveBeenCalled();
          expect(requests).toEqual([]);
          releaseReply.resolve();
          await expect(delivery.promise).resolves.toEqual({ messageId: 900 });
          expect(requests).toEqual([
            expect.objectContaining({ chat_id: -100, text: "reply after worker crash" }),
          ]);
          expect(replacementBot.handleUpdate).not.toHaveBeenCalled();
          expect(transport.close).not.toHaveBeenCalled();
        } finally {
          releaseReply.resolve();
          adopted.resolve();
          abort.abort();
          idleWorker.stop();
          await vi.advanceTimersByTimeAsync(20_000);
          await runPromise;
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
        expect(firstFetchSignal?.aborted).toBe(true);
        expect(transport.close).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a fresh bot before draining updates after an isolated worker crash", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    let releaseBackoff: (() => void) | undefined;
    const backoff = new Promise<void>((resolve) => {
      releaseBackoff = resolve;
    });
    sleepWithAbortMock.mockImplementationOnce(async () => {
      await backoff;
      return undefined;
    });

    let firstMediaSignal: AbortSignal | undefined;
    let rejectFirstWorker: ((err: Error) => void) | undefined;
    const firstWorkerDone = new Promise<void>((_resolve, reject) => {
      rejectFirstWorker = reject;
    });
    const firstHandleUpdate = vi.fn(async () => {
      rejectFirstWorker?.(new Error("worker crashed"));
      if (!firstMediaSignal) {
        throw new Error("Expected the first polling cycle signal");
      }
      await waitForAbortSignal(firstMediaSignal);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const secondHandleUpdate = vi.fn(async () => undefined);
    const createBot = (handleUpdate: (update: { update_id?: number }) => Promise<unknown>) => ({
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate,
      stop: vi.fn(async () => undefined),
    });
    createTelegramBotMock
      .mockImplementationOnce((opts: { mediaAbortSignal?: AbortSignal }) => {
        firstMediaSignal = opts.mediaAbortSignal;
        return createBot(firstHandleUpdate);
      })
      .mockReturnValueOnce(createBot(secondHandleUpdate));

    let workerIndex = 0;
    let stopSecondWorker: (() => void) | undefined;
    const secondWorkerDone = new Promise<void>((resolve) => {
      stopSecondWorker = resolve;
    });
    const createWorker = vi.fn(() => {
      workerIndex += 1;
      if (workerIndex === 1) {
        return {
          onMessage: vi.fn(() => () => undefined),
          stop: vi.fn(async () => undefined),
          task: vi.fn(async () => await firstWorkerDone),
        };
      }
      return {
        onMessage: vi.fn(() => () => undefined),
        stop: vi.fn(async () => {
          stopSecondWorker?.();
        }),
        task: vi.fn(async () => await secondWorkerDone),
      };
    });

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        ingress: {
          stateDir: tempDir,
          createWorker,
          drainIntervalMs: 10,
        },
      });
      const runPromise = session.runUntilAbort();
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(1));

      await writeSpooledTestUpdates(tempDir, [
        topicUpdate(42, 10, "crash the old bot"),
        topicUpdate(43, 11, "wait for the fresh bot"),
      ]);
      await vi.advanceTimersByTimeAsync(50);
      // Topic 42 starts on the first bot; topic 43 is a different lane and may
      // also start before the worker crash fully stops the cycle.
      await waitForTelegramTestState(() =>
        expect(firstHandleUpdate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      await waitForTelegramTestState(() => expect(sleepWithAbortMock).toHaveBeenCalledTimes(1));
      // While restart backoff is held, the fresh bot must not process updates.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(secondHandleUpdate).toHaveBeenCalledTimes(0);

      releaseBackoff?.();
      await vi.advanceTimersByTimeAsync(2_000);
      // Fresh bot drains remaining work (both lanes if still pending).
      await waitForTelegramTestState(() =>
        expect(secondHandleUpdate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;

      expect(createWorker).toHaveBeenCalledTimes(2);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
    } finally {
      releaseBackoff?.();
      abort.abort();
      stopSecondWorker?.();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats isolated ingress worker rejection after abort as clean shutdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot());

    let rejectWorker: ((err: Error) => void) | undefined;
    const workerDone = new Promise<void>((_resolve, reject) => {
      rejectWorker = reject;
    });
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn(() => () => undefined),
      stop: vi.fn(async () => {
        rejectWorker?.(new Error("worker exited with code 1"));
      }),
      task: vi.fn(async () => {
        await workerDone;
      }),
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        ingress: {
          stateDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      const runPromise = session.runUntilAbort();
      await waitForTelegramTestState(() => expect(createWorker).toHaveBeenCalledTimes(1));
      abort.abort();
      await vi.advanceTimersByTimeAsync(20_000);
      await runPromise;

      expect(createWorker).toHaveBeenCalledTimes(1);
      expectLogExcludes(log, "isolated polling ingress failed");
    } finally {
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates fatal isolated ingress polling errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    const transport = makeTelegramTransport();
    transport.close.mockRejectedValueOnce(new Error("transport close failed"));
    const workerStop = vi.fn(async () => undefined);
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot());

    let listener: WorkerPollErrorListener | undefined;
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((next: WorkerPollErrorListener) => {
        listener = next;
        return () => undefined;
      }),
      stop: workerStop,
      task: vi.fn(async () => {
        listener?.({
          type: "poll-error",
          message: "Unauthorized",
          errorCode: 401,
          finishedAt: Date.now(),
        });
        throw new Error("Telegram ingress worker exited with code 1");
      }),
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        setStatus,
        telegramTransport: transport,
        ingress: {
          stateDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      await expect(session.runUntilAbort()).rejects.toThrow("Unauthorized");

      expect(createWorker).toHaveBeenCalledTimes(1);
      expect(workerStop).toHaveBeenCalledOnce();
      expect(transport.close).toHaveBeenCalledOnce();
      expect(statusPatches(setStatus).at(-1)).toMatchObject({ connected: false });
      expectLogExcludes(log, "isolated polling ingress failed");
      expect(
        statusPatches(setStatus).some(
          (patch) =>
            patch.connected === false &&
            patch.lifecycle === "blocked" &&
            patch.terminalDisconnect === true &&
            patch.lastError === "Unauthorized",
        ),
      ).toBe(true);
    } finally {
      abort.abort();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restarts isolated ingress on a getUpdates conflict instead of crashing the account", async () => {
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const setStatus = vi.fn();
    // 409 conflicts are not "recoverable network errors"; the conflict branch
    // must restart the cycle before that classifier is consulted.
    isRecoverableTelegramNetworkErrorMock.mockReturnValue(false);
    const deleteWebhook = vi.fn(async () => true);
    createTelegramBotMock.mockImplementation(() => makeIsolatedBot({ deleteWebhook }));
    const transport1 = makeTelegramTransport();
    const transport2 = makeTelegramTransport();
    const createTelegramTransport = vi
      .fn<() => ReturnType<typeof makeTelegramTransport>>()
      .mockReturnValueOnce(transport2);

    let workerCycle = 0;
    let listener: WorkerPollErrorListener | undefined;
    const createWorker = vi.fn(() => ({
      onMessage: vi.fn((next: WorkerPollErrorListener) => {
        listener = next;
        return () => undefined;
      }),
      stop: vi.fn(async () => undefined),
      task: vi.fn(async () => {
        workerCycle += 1;
        if (workerCycle === 1) {
          listener?.({
            type: "poll-error",
            message: "Conflict: terminated by other getUpdates request",
            errorCode: 409,
            finishedAt: Date.now(),
          });
          throw new Error("Telegram ingress worker exited with code 1");
        }
        abort.abort();
      }),
    }));

    try {
      const session = createPollingSession({
        abortSignal: abort.signal,
        log,
        setStatus,
        telegramTransport: transport1,
        createTelegramTransport,
        ingress: {
          stateDir: tempDir,
          createWorker,
          drainIntervalMs: 100,
        },
      });

      await session.runUntilAbort();

      expect(createWorker).toHaveBeenCalledTimes(2);
      // The conflict resets webhook cleanup so the next cycle re-runs deleteWebhook.
      expect(deleteWebhook).toHaveBeenCalledTimes(2);
      // The conflict marks the transport dirty so the next cycle gets a fresh socket.
      expect(createTelegramTransport).toHaveBeenCalledTimes(1);
      expect(transport1.close).toHaveBeenCalledOnce();
      expect(transport2.close).toHaveBeenCalledOnce();
      expectLogIncludes(log, "Another OpenClaw gateway, script, or Telegram poller");
      expect(
        statusPatches(setStatus).some(
          (patch) =>
            patch.connected === false &&
            String(patch.lastError).includes("Another OpenClaw gateway"),
        ),
      ).toBe(true);
    } finally {
      abort.abort();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries a timed-out spooled handler before later same-lane updates without restart", async () => {
    // Core drain releases 42 for retry before 43 on the same bot.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const abort = new AbortController();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
    const log = vi.fn();
    const events: string[] = [];
    const bot = {
      api: {
        deleteWebhook: vi.fn(async () => true),
        config: { use: vi.fn() },
      },
      init: vi.fn(async () => undefined),
      handleUpdate: vi.fn(async (update: { update_id?: number }) => {
        events.push(`bot:${update.update_id}`);
        if (update.update_id === 42 && events.filter((event) => event === "bot:42").length === 1) {
          // Hang until the core watchdog aborts the drain lifecycle.
          await new Promise<void>(() => {});
        }
        if (update.update_id === 43) {
          abort.abort();
        }
      }),
      stop: vi.fn(async () => undefined),
    };
    createTelegramBotMock.mockReturnValue(bot);
    await writeSpooledTestUpdates(tempDir, [
      topicUpdate(42, 10, "wedged topic 10 turn"),
      topicUpdate(43, 10, "later topic 10 turn"),
    ]);

    const worker = createIdleIngressWorker();
    const session = createPollingSession({
      abortSignal: abort.signal,
      log,
      ingress: {
        stateDir: tempDir,
        createWorker: worker.createWorker,
        drainIntervalMs: 10,
        spooledUpdateHandlerTimeoutMs: 100,
      },
    });

    try {
      const runPromise = session.runUntilAbort();
      await waitForTelegramTestState(() => expect(events).toEqual(["bot:42"]));

      await vi.advanceTimersByTimeAsync(2_000);
      await waitForTelegramTestState(() => expect(events).toEqual(["bot:42", "bot:42", "bot:43"]));
      await vi.advanceTimersByTimeAsync(15_000);
      await runPromise;

      // No private-drain session restart for handler timeout.
      expect(worker.createWorker).toHaveBeenCalledTimes(1);
      expect(createTelegramBotMock).toHaveBeenCalledTimes(1);
      expect(await pendingUpdateIds(tempDir, "all")).toEqual([]);
      expect(await failedUpdateIds(tempDir)).toEqual([]);
      expectLogIncludes(log, "handler-timeout");
    } finally {
      abort.abort();
      worker.stop();
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("starts the worker after recoverable webhook cleanup failure", async () => {
    const abort = new AbortController();
    const cleanup = vi.fn(async () => {
      throw new Error("deleteWebhook timed out");
    });
    const bot = makeIsolatedBot({ deleteWebhook: cleanup });
    createTelegramBotMock.mockReturnValueOnce(bot);
    const createWorker = vi.fn(() => ({
      onMessage: () => () => {},
      task: async () => {
        abort.abort();
      },
      stop: async () => {},
    }));
    const session = createPollingSession({
      abortSignal: abort.signal,
      ingress: { createWorker },
    });
    await session.runUntilAbort();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledBefore(createWorker);
    expect(bot.stop).toHaveBeenCalledOnce();
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
