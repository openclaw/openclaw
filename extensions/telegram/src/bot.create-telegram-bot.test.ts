// Telegram tests cover bot.create telegram bot plugin behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildPluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAcpTopicBinding,
  createConfiguredBindingRoute,
} from "./bot-native-command-dispatch.test-support.js";
import {
  makeCallbackRetryContext,
  makePrivateTextContext,
  telegramBotInfoForTest,
} from "./bot.create-telegram-bot.test-support.js";
import {
  createTelegramCallbackContext,
  runTelegramTestMiddlewareChain,
  type TelegramTestContext as TelegramMiddlewareTestContext,
} from "./bot.test-helpers.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", { spy: true });
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", { spy: true });

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const pluginStateTestRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
const bindingRuntime = await import("openclaw/plugin-sdk/conversation-binding-runtime");
const telegramMediaResolver = await import("./bot/delivery.resolve-media.js");
const tempStateDirs: string[] = [];
let previousStateDir: string | undefined;
const {
  answerCallbackQuerySpy,
  botCtorSpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  getLoadConfigMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  middlewareUseSpy,
  onSpy,
  replySpy,
  sendMessageSpy,
  sequentializeSpy,
  telegramBotDepsForTest,
  throttlerSpy,
  useSpy,
} = harness;
type BuildModelsProviderDataMock = ReturnType<
  typeof vi.fn<NonNullable<typeof telegramBotDepsForTest.buildModelsProviderData>>
>;
const { defaultTelegramNativeCommandDeps } = await import("./bot-native-command-deps.runtime.js");
const messageDispatchDedupe = await import("./message-dispatch-dedupe.js");
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const {
  recordTelegramMessageProcessingResult,
  runWithTelegramSpooledReplayUpdate,
  TelegramSpooledReplayProcessingError,
} = await import("./bot-processing-outcome.js");
const {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
  resetTelegramTopicNameCacheForTest,
} = await import("./runtime.test-support.js");
const { setTelegramRuntime } = await import("./runtime.js");
let createTelegramBot: (opts: TelegramBotOptions) => ReturnType<typeof createTelegramBotBase>;

function createTelegramBotTestStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-bot-"));
  tempStateDirs.push(dir);
  return dir;
}

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const upsertChannelPairingRequest = getUpsertChannelPairingRequestMock();

const ORIGINAL_TZ = process.env.TZ;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;
const INBOUND_DEBOUNCE_MS = 4321;
let forumCacheChatId = -1_008_000_000_000;

function nextForumCacheChatId(): number {
  forumCacheChatId += 1;
  return forumCacheChatId;
}

type TelegramMessageHandler = (ctx: TelegramMiddlewareTestContext) => Promise<void>;

function configureOpenDm(
  params: {
    debounceMs?: number;
    timezone?: "envelopeTimezone" | "userTimezone";
  } = {},
): void {
  loadConfig.mockReturnValue({
    agents: params.timezone
      ? { defaults: { [params.timezone]: params.timezone === "userTimezone" ? "UTC" : "utc" } }
      : undefined,
    messages: { inbound: { debounceMs: params.debounceMs ?? 0 } },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  });
}

function getTelegramHandler(name: "message" | "callback_query"): TelegramMessageHandler {
  return requireValue(getOnHandler(name) as TelegramMessageHandler | undefined, `${name} handler`);
}

const getMessageHandler = () => getTelegramHandler("message");
const getCallbackHandler = () => getTelegramHandler("callback_query");

function takeLatestTimerCallback(delayMs: number): () => void {
  const setTimeoutMock = vi.mocked(globalThis.setTimeout);
  const callIndex = setTimeoutMock.mock.calls.findLastIndex((call) => call[1] === delayMs);
  expect(callIndex).toBeGreaterThanOrEqual(0);
  clearTimeout(setTimeoutMock.mock.results[callIndex]?.value as ReturnType<typeof setTimeout>);
  return requireValue(
    setTimeoutMock.mock.calls[callIndex]?.[0] as (() => void) | undefined,
    `timer callback for ${delayMs}ms`,
  );
}

async function dispatchPrivateText(
  messageHandler: TelegramMessageHandler,
  params: Parameters<typeof makePrivateTextContext>[0],
): Promise<void> {
  await runTelegramMiddlewareChain({
    ctx: makePrivateTextContext(params),
    finalHandler: messageHandler,
  });
}

async function dispatchSpooledPrivateText(
  messageHandler: TelegramMessageHandler,
  params: Parameters<typeof makePrivateTextContext>[0] & {
    updateId: number;
    replayUpdate?: "id" | "full";
  },
) {
  const ctx = makePrivateTextContext(params);
  const update = ctx.update ?? {};
  const replayUpdate =
    params.replayUpdate === "full" ? Object.assign({}, update, { message: ctx.message }) : update;
  return await runWithTelegramSpooledReplayUpdate(replayUpdate, async () => {
    await runTelegramMiddlewareChain({ ctx, finalHandler: messageHandler });
  });
}

function installTelegramTopicStateForTest(): void {
  resetTelegramTopicNameCacheForTest();
  setTelegramPluginStateRuntimeForTests();
}

async function dispatchSpooledNativeStop(
  params: Omit<Parameters<typeof dispatchSpooledPrivateText>[1], "text" | "replayUpdate"> & {
    match?: string;
  },
) {
  const { match = "", ...messageParams } = params;
  const stopHandler = requireValue(
    commandSpy.mock.calls.find((call) => call[0] === "stop")?.[1] as
      | TelegramMessageHandler
      | undefined,
    "registered native stop handler",
  );
  return await dispatchSpooledPrivateText(
    async (ctx) => await stopHandler({ ...ctx, me: telegramBotInfoForTest, match }),
    {
      ...messageParams,
      text: match ? `/stop ${match}` : "/stop",
      replayUpdate: "full",
      message: {
        ...messageParams.message,
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      },
    },
  );
}

async function setupUpdateOffsetTracker(params: { lastUpdateId: number }) {
  sequentializeSpy.mockImplementationOnce(
    () => async (_ctx: unknown, next: () => Promise<void>) => {
      await next();
    },
  );
  const onUpdateId = vi.fn<(updateId: number) => void | Promise<void>>();
  await createTelegramBot({
    token: "tok",
    updateOffset: { lastUpdateId: params.lastUpdateId, onUpdateId },
  });
  return {
    onUpdateId,
    run: (ctx: Record<string, unknown>, finalNext: () => Promise<void>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, async () => finalNext()),
  };
}

async function runTelegramMiddlewareChain(params: {
  ctx: TelegramMiddlewareTestContext;
  finalHandler: (ctx: TelegramMiddlewareTestContext) => Promise<void>;
}): Promise<void> {
  await runTelegramTestMiddlewareChain(middlewareUseSpy, params.ctx, params.finalHandler);
}

function installPerKeySequentializer(): void {
  sequentializeSpy.mockImplementationOnce(() => {
    const lanes = new Map<string, Promise<void>>();
    return async (ctx: TelegramMiddlewareTestContext, next: () => Promise<void>) => {
      const constraint = harness.sequentializeKey?.(ctx) ?? "default";
      const keys = Array.isArray(constraint) ? constraint : [constraint];
      const previous = Promise.all(keys.map((key) => lanes.get(key) ?? Promise.resolve()));
      const current = previous.then(async () => {
        await next();
      });
      const tracked = current.catch(() => undefined);
      for (const key of keys) {
        lanes.set(key, tracked);
      }

      try {
        await current;
      } finally {
        for (const key of keys) {
          if (lanes.get(key) === tracked) {
            lanes.delete(key);
          }
        }
      }
    };
  });
}

async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

async function flushTelegramTestMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function makeGenericCallbackContext(params: { id: string; updateId?: number }) {
  const data = "skip nightly build tonight";
  return createTelegramCallbackContext({
    id: params.id,
    data,
    update: params.updateId === undefined ? undefined : { update_id: params.updateId },
    message: {
      reply_markup: { inline_keyboard: [[{ text: "Skip tonight", callback_data: data }]] },
    },
  });
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getBotCtorOptions(callIndex = 0): Record<string, unknown> {
  const call = requireValue(
    botCtorSpy.mock.calls.at(callIndex),
    `bot constructor call ${callIndex}`,
  );
  expect(call[0]).toBe("tok");
  return requireRecord(call[1], `bot constructor options ${callIndex}`);
}

function expectBotClientFields(expected: Record<string, unknown>, callIndex = 0): void {
  const options = getBotCtorOptions(callIndex);
  expectRecordFields(options.client, expected, `bot constructor client ${callIndex}`);
}

describe("createTelegramBot", () => {
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    pluginStateTestRuntime.resetPluginStateStoreForTests();
    clearPluginInteractiveHandlers();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    for (const dir of tempStateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = createTelegramBotTestStateDir();
    clearPluginInteractiveHandlers();
    resetTelegramAccountThrottlersForTest();
    throttlerSpy.mockReset();
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        botInfo: telegramBotInfoForTest,
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
    pluginStateTestRuntime.resetPluginStateStoreForTests({ closeDatabase: false });
  });

  // groupPolicy tests

  it("reuses the grammY throttler for the same token", async () => {
    await createTelegramBot({ token: "tok" });
    await createTelegramBot({ token: "tok" });
    await createTelegramBot({ token: "other" });

    expect(throttlerSpy).toHaveBeenCalledTimes(2);
    expect(useSpy).toHaveBeenCalledTimes(3);
  });

  it("normalizes full Telegram bot endpoint apiRoot before passing it to grammY", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          apiRoot: "https://api.telegram.org/bot123456:ABC/",
        },
      },
    });

    await createTelegramBot({ token: "tok" });

    expectBotClientFields({ apiRoot: "https://api.telegram.org" });
  });

  it("keeps poll registry preparation failures retryable during durable replay", async () => {
    const readError = new Error("poll registry unavailable");
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>() => ({
      register: async () => {},
      registerIfAbsent: async () => false,
      lookup: async (): Promise<T | undefined> => {
        throw readError;
      },
      consume: async () => undefined,
      delete: async () => false,
      entries: async () => [],
      clear: async () => {},
    });
    const openSyncKeyedStore: TelegramRuntime["state"]["openSyncKeyedStore"] = <
      T,
    >(): PluginStateSyncKeyedStore<T> => ({
      register: () => {},
      registerIfAbsent: () => false,
      lookup: (): T | undefined => {
        throw readError;
      },
      consume: () => undefined,
      delete: () => false,
      entries: () => [],
      clear: () => {},
    });
    setTelegramRuntime({
      state: { openKeyedStore, openSyncKeyedStore },
      channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    } as TelegramRuntime);
    await createTelegramBot({ token: "tok" });
    const update = {
      update_id: 41,
      poll_answer: {
        poll_id: "poll-retry",
        option_ids: [0],
        user: { id: 9, first_name: "Ada" },
      },
    };

    try {
      await expect(
        runWithTelegramSpooledReplayUpdate(update, async () => {
          await runTelegramTestMiddlewareChain(middlewareUseSpy, { update }, async () => {});
        }),
      ).rejects.toMatchObject({
        name: TelegramSpooledReplayProcessingError.name,
        cause: readError,
      });
    } finally {
      clearTelegramRuntimeForTest();
    }
  });

  it.each([
    {
      name: "bot voter",
      pollAnswer: {
        poll_id: "poll-skip",
        option_ids: [0],
        user: { id: 9, first_name: "Bot", is_bot: true },
      },
    },
    {
      name: "vote retraction",
      pollAnswer: {
        poll_id: "poll-skip",
        option_ids: [],
        user: { id: 9, first_name: "Ada" },
      },
    },
    {
      name: "voter chat without a user identity",
      pollAnswer: {
        poll_id: "poll-skip",
        option_ids: [0],
        voter_chat: { id: -100123, type: "supergroup", title: "Reviewers" },
      },
    },
  ])("skips registry preparation for $name", async ({ pollAnswer }) => {
    const lookup = vi.fn(async () => {
      throw new Error("registry should not be read");
    });
    const openKeyedStore: TelegramRuntime["state"]["openKeyedStore"] = <T>() =>
      ({ lookup }) as unknown as PluginStateKeyedStore<T>;
    setTelegramRuntime({
      state: { openKeyedStore },
      channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    } as TelegramRuntime);
    await createTelegramBot({ token: "tok" });
    const update = { update_id: 42, poll_answer: pollAnswer };
    const reachedHandlers = vi.fn();

    try {
      await runTelegramTestMiddlewareChain(middlewareUseSpy, { update }, reachedHandlers);
      expect(lookup).not.toHaveBeenCalled();
      expect(reachedHandlers).toHaveBeenCalledOnce();
    } finally {
      clearTelegramRuntimeForTest();
    }
  });

  it("preserves same-chat reply order when a debounced run is still active", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });
    installPerKeySequentializer();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const startedBodies: string[] = [];
    const firstRunStarted = createDeferred<void>();
    const firstRunGate = createDeferred<void>();
    const sourceWork: Promise<unknown>[] = [];

    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      if (body.includes("first")) {
        firstRunStarted.resolve();
        await firstRunGate.promise;
      }
      return { text: `reply:${body}` };
    });

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const first = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 101,
        messageId: 101,
        text: "first",
        replayUpdate: "full",
      });
      sourceWork.push(requireValue(first.deferredWork, "first source participant").task);

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();

      await firstRunStarted.promise;
      expect(startedBodies).toHaveLength(1);
      expect(startedBodies[0]).toContain("first");

      const second = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 102,
        messageId: 102,
        text: "second",
        date: 1736380801,
        replayUpdate: "full",
      });
      sourceWork.push(requireValue(second.deferredWork, "second source participant").task);

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await Promise.resolve();

      expect(startedBodies).toHaveLength(1);
      expect(sendMessageSpy).not.toHaveBeenCalled();

      firstRunGate.resolve();

      await Promise.all(sourceWork);
      expect(startedBodies).toHaveLength(2);
      expect(sendMessageSpy).toHaveBeenCalledTimes(2);

      expect(startedBodies[0]).toContain("first");
      expect(startedBodies[1]).toContain("second");
      const sentBodies = sendMessageSpy.mock.calls.map((call) => String(call[1]));
      expect(sentBodies[0]).toContain("first");
      expect(sentBodies[1]).toContain("second");
    } finally {
      firstRunGate.resolve();
      await Promise.allSettled(sourceWork);
      setTimeoutSpy.mockRestore();
    }
  });

  it("applies committed Telegram debounce changes only when new input arrives", async () => {
    const initialConfig: OpenClawConfig = {
      messages: { inbound: { byChannel: { telegram: 1000 } } },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    loadConfig.mockReturnValue(initialConfig);
    setRuntimeConfigSnapshot(initialConfig, initialConfig);
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    const sourceWork: Promise<unknown>[] = [];

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const first = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 511,
        messageId: 511,
        text: "before delay change",
        replayUpdate: "full",
      });
      const firstParticipant = requireValue(first.deferredWork, "first source participant");
      sourceWork.push(firstParticipant.task);
      await vi.advanceTimersByTimeAsync(100);
      const shorterConfig: OpenClawConfig = {
        ...initialConfig,
        messages: { inbound: { byChannel: { telegram: 500 } } },
      };
      loadConfig.mockReturnValue(shorterConfig);
      setRuntimeConfigSnapshot(shorterConfig, shorterConfig);
      await vi.advanceTimersByTimeAsync(899);
      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstParticipant.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["before delay change"]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["511"]);

      const second = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 512,
        messageId: 512,
        text: "new batch",
        replayUpdate: "full",
      });
      sourceWork.push(requireValue(second.deferredWork, "second source participant").task);
      await vi.advanceTimersByTimeAsync(100);
      const longerConfig: OpenClawConfig = {
        ...initialConfig,
        messages: { inbound: { byChannel: { telegram: 1500 } } },
      };
      loadConfig.mockReturnValue(longerConfig);
      setRuntimeConfigSnapshot(longerConfig, longerConfig);
      const third = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 513,
        messageId: 513,
        text: "extends batch",
        replayUpdate: "full",
      });
      sourceWork.push(requireValue(third.deferredWork, "third source participant").task);
      await vi.advanceTimersByTimeAsync(1499);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["before delay change"]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.all(sourceWork)).resolves.toEqual([
        { kind: "completed" },
        { kind: "completed" },
        { kind: "completed" },
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "before delay change",
        "new batch\nextends batch",
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["511", "513"]);
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(sourceWork);
      vi.useRealTimers();
      clearRuntimeConfigSnapshot();
    }
  });

  it("assembles a default short-long-short burst despite intervening message IDs", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { envelopeTimezone: "utc" } },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1736380800000);
    replySpy.mockResolvedValue(undefined);

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const short = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 301,
        messageId: 301,
        text: "A".repeat(611),
        replayUpdate: "full",
      });
      await vi.advanceTimersByTimeAsync(283);
      const long = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 302,
        messageId: 302,
        text: "B".repeat(4065),
        date: 1736380801,
        replayUpdate: "full",
      });
      await vi.advanceTimersByTimeAsync(1400);
      const continuation = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 303,
        messageId: 305,
        text: "C".repeat(3354),
        date: 1736380802,
        replayUpdate: "full",
      });

      await vi.advanceTimersByTimeAsync(2703);
      await expect(
        Promise.all([
          requireValue(short.deferredWork, "short source participant").task,
          requireValue(long.deferredWork, "long source participant").task,
          requireValue(continuation.deferredWork, "continuation source participant").task,
        ]),
      ).resolves.toEqual([{ kind: "completed" }, { kind: "completed" }, { kind: "completed" }]);

      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "A".repeat(611) + "\n" + "B".repeat(4065) + "C".repeat(3354),
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["305"]);
      expect(
        replySpy.mock.calls.map(([ctx]) => ctx.SessionTranscriptContext?.beforeTimestampMs),
      ).toEqual([1736380800000]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.Timestamp)).toEqual([1736380802000]);

      const next = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 304,
        messageId: 306,
        text: "next independent message",
        replayUpdate: "full",
      });
      await vi.advanceTimersByTimeAsync(3000);
      await expect(
        requireValue(next.deferredWork, "next source participant").task,
      ).resolves.toEqual({
        kind: "completed",
      });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "A".repeat(611) + "\n" + "B".repeat(4065) + "C".repeat(3354),
        "next independent message",
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["305", "306"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an expired fragment behind an earlier active message before releasing that message", async () => {
    configureOpenDm({ debounceMs: 3000, timezone: "envelopeTimezone" });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const earlierStarted = createDeferred<void>();
    const releaseEarlier = createDeferred<void>();
    let earlierWork: Promise<unknown> | undefined;
    replySpy.mockImplementation(async (ctx: MsgContext) => {
      if (ctx.RawBody === "earlier message") {
        earlierStarted.resolve();
        await releaseEarlier.promise;
      }
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const earlier = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 311,
        messageId: 311,
        text: "earlier message",
        replayUpdate: "full",
      });
      earlierWork = requireValue(earlier.deferredWork, "earlier source participant").task;
      await vi.advanceTimersByTimeAsync(3000);
      await earlierStarted.promise;
      const fragment = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 312,
        messageId: 312,
        text: "B".repeat(4065),
        replayUpdate: "full",
      });
      const fragmentParticipant = requireValue(
        fragment.deferredWork,
        "fragment source participant",
      );
      await vi.advanceTimersByTimeAsync(3000);
      await dispatchPrivateText(messageHandler, {
        updateId: 313,
        messageId: 313,
        text: "stop",
      });

      expect(fragmentParticipant.isSettled()).toBe(true);
      await expect(fragmentParticipant.task).resolves.toEqual({ kind: "skipped" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["earlier message", "stop"]);

      releaseEarlier.resolve();
      await expect(earlierWork).resolves.toEqual({
        kind: "completed",
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["earlier message", "stop"]);
    } finally {
      releaseEarlier.resolve();
      await earlierWork;
      vi.useRealTimers();
    }
  });

  it.each(["stop", "/stop@openclaw_bot"] as const)(
    "lets %s bypass and cancel pending same-chat inbound debounce",
    async (stopText) => {
      configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "userTimezone" });

      installPerKeySequentializer();

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const startedBodies: string[] = [];
      let reusedWork: Promise<unknown> | undefined;
      replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
        await opts?.onReplyStart?.();
        const body = ctx.Body ?? "";
        startedBodies.push(body);
        return { text: `reply:${body}` };
      });

      try {
        await createTelegramBot({ token: "tok" });
        const messageHandler = getMessageHandler();
        await dispatchPrivateText(messageHandler, { updateId: 101, messageId: 101, text: "first" });
        const flushFirst = takeLatestTimerCallback(INBOUND_DEBOUNCE_MS);
        await dispatchPrivateText(messageHandler, {
          updateId: 102,
          messageId: 102,
          text: stopText,
          date: 1736380801,
        });

        expect(startedBodies).toHaveLength(1);
        expect(startedBodies[0]).toContain("stop");

        flushFirst();
        await Promise.resolve();
        expect(startedBodies).toHaveLength(1);
        expect(sendMessageSpy.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain(
          "reply:first",
        );

        const reused = await dispatchSpooledPrivateText(messageHandler, {
          updateId: 103,
          messageId: 101,
          text: "first",
          replayUpdate: "full",
        });
        reusedWork = requireValue(reused.deferredWork, "reused source participant").task;
        takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
        await reusedWork;
        expect(startedBodies).toHaveLength(2);
        expect(startedBodies[1]).toContain("first");
      } finally {
        await Promise.allSettled([reusedWork]);
        setTimeoutSpy.mockRestore();
      }
    },
  );

  it.each([
    { buffer: "ordinary text", text: "A".repeat(611) },
    { buffer: "text fragments", text: "B".repeat(4065) },
  ])("native stop cancels pending $buffer and permits same-key reuse", async ({ text }) => {
    loadConfig.mockReturnValue({
      commands: { native: true, allowFrom: { telegram: ["42"] } },
      messages: { inbound: { byChannel: { telegram: 3000 } } },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    const sourceWork: Promise<unknown>[] = [];

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const pending = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 401,
        messageId: 401,
        text,
        replayUpdate: "full",
      });
      const participant = requireValue(pending.deferredWork, "pending source participant");
      sourceWork.push(participant.task);
      await vi.advanceTimersByTimeAsync(100);

      await dispatchSpooledNativeStop({ updateId: 402, messageId: 402 });

      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        CommandBody: "/stop",
        CommandAuthorized: true,
        MessageSid: "402",
      });
      expect(participant.isSettled()).toBe(true);
      await expect(participant.task).resolves.toEqual({ kind: "skipped" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["/stop"]);

      const next = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 403,
        messageId: 403,
        text: "message after native stop",
        replayUpdate: "full",
      });
      const nextParticipant = requireValue(next.deferredWork, "next source participant");
      sourceWork.push(nextParticipant.task);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(nextParticipant.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "/stop",
        "message after native stop",
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["402", "403"]);
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(sourceWork);
      vi.useRealTimers();
    }
  });

  it("unauthorized native group stop leaves the sender's pending fragment intact", async () => {
    installTelegramTopicStateForTest();
    const chatId = nextForumCacheChatId();
    const topic = {
      chat: { id: chatId, type: "supergroup", title: "OpenClaw Ops", is_forum: true },
      message_thread_id: 99,
      is_topic_message: true,
    };
    loadConfig.mockReturnValue({
      commands: { native: true, allowFrom: { telegram: ["99"] } },
      messages: { inbound: { byChannel: { telegram: 3000 } } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    let sourceWork: Promise<unknown> | undefined;

    try {
      await createTelegramBot({ token: "tok" });
      const pending = await dispatchSpooledPrivateText(getMessageHandler(), {
        updateId: 411,
        messageId: 411,
        text: "U".repeat(4065),
        message: topic,
        replayUpdate: "full",
      });
      const participant = requireValue(pending.deferredWork, "pending source participant");
      sourceWork = participant.task;
      await vi.advanceTimersByTimeAsync(100);

      await dispatchSpooledNativeStop({ updateId: 412, messageId: 412, message: topic });

      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
      expect(participant.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(participant.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["U".repeat(4065)]);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        MessageSid: "411",
        SenderId: "42",
        MessageThreadId: 99,
      });
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
      await sourceWork;
      vi.useRealTimers();
      clearTelegramRuntimeForTest();
      resetTelegramTopicNameCacheForTest();
    }
  });

  it.each([
    { scope: "another sender", senderId: 43, threadId: 99 },
    { scope: "another topic", senderId: 42, threadId: 100 },
  ])("native stop preserves a pending fragment from $scope", async ({ senderId, threadId }) => {
    installTelegramTopicStateForTest();
    const chatId = nextForumCacheChatId();
    const chat = { id: chatId, type: "supergroup", title: "OpenClaw Ops", is_forum: true };
    loadConfig.mockReturnValue({
      commands: { native: true, allowFrom: { telegram: ["42"] } },
      messages: { inbound: { byChannel: { telegram: 3000 } } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    const sourceWork: Promise<unknown>[] = [];

    try {
      await createTelegramBot({ token: "tok" });
      const target = await dispatchSpooledPrivateText(getMessageHandler(), {
        updateId: 419,
        messageId: 419,
        text: "T".repeat(4065),
        message: { chat, message_thread_id: 99, is_topic_message: true },
        replayUpdate: "full",
      });
      const targetParticipant = requireValue(target.deferredWork, "stop target participant");
      sourceWork.push(targetParticipant.task);
      const pending = await dispatchSpooledPrivateText(getMessageHandler(), {
        updateId: 421,
        messageId: 421,
        from: { id: senderId, first_name: "Pending sender" },
        text: "P".repeat(4065),
        message: { chat, message_thread_id: threadId, is_topic_message: true },
        replayUpdate: "full",
      });
      const participant = requireValue(pending.deferredWork, "other source participant");
      sourceWork.push(participant.task);
      await vi.advanceTimersByTimeAsync(100);

      await dispatchSpooledNativeStop({
        updateId: 422,
        messageId: 422,
        message: { chat, message_thread_id: 99, is_topic_message: true },
      });

      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        CommandAuthorized: true,
        MessageSid: "422",
        SenderId: "42",
        MessageThreadId: 99,
      });
      expect(targetParticipant.isSettled()).toBe(true);
      await expect(targetParticipant.task).resolves.toEqual({ kind: "skipped" });
      expect(participant.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(participant.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["/stop", "P".repeat(4065)]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["422", "421"]);
      expect(replySpy.mock.calls[1]?.[0]).toMatchObject({
        SenderId: String(senderId),
        MessageThreadId: threadId,
      });
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(sourceWork);
      vi.useRealTimers();
      clearTelegramRuntimeForTest();
      resetTelegramTopicNameCacheForTest();
    }
  });

  it("does not cancel prior input for native stop with unsupported arguments", async () => {
    loadConfig.mockReturnValue({
      commands: { native: true, allowFrom: { telegram: ["42"] } },
      messages: { inbound: { byChannel: { telegram: 3000 } } },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    let sourceWork: Promise<unknown> | undefined;

    try {
      await createTelegramBot({ token: "tok" });
      const pending = await dispatchSpooledPrivateText(getMessageHandler(), {
        updateId: 431,
        messageId: 431,
        text: "Q".repeat(4065),
        replayUpdate: "full",
      });
      const participant = requireValue(pending.deferredWork, "pending source participant");
      sourceWork = participant.task;
      await vi.advanceTimersByTimeAsync(100);

      await dispatchSpooledNativeStop({
        updateId: 432,
        messageId: 432,
        match: "later",
      });

      expect(replySpy.mock.calls.find(([ctx]) => ctx.MessageSid === "432")?.[0]).toMatchObject({
        CommandSource: "native",
        CommandAuthorized: true,
        CommandBody: "/stop later",
        MessageSid: "432",
      });
      await expect(participant.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "Q".repeat(4065),
        "/stop later",
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["431", "432"]);
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
      await sourceWork;
      vi.useRealTimers();
    }
  });

  it("stop cancels ordinary and forwarded batches queued behind an active turn", async () => {
    configureOpenDm({ debounceMs: 3000, timezone: "envelopeTimezone" });
    installPerKeySequentializer();
    const attachmentPath = path.join(
      requireValue(process.env.OPENCLAW_STATE_DIR, "test state directory"),
      "caption.txt",
    );
    writeFileSync(attachmentPath, "attachment");
    const resolveMedia = vi.spyOn(telegramMediaResolver, "resolveMedia");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const earlierStarted = createDeferred<void>();
    const releaseEarlier = createDeferred<void>();
    let earlierWork: Promise<unknown> | undefined;
    replySpy.mockImplementation(async (ctx: MsgContext) => {
      if (ctx.MessageSid === "440") {
        earlierStarted.resolve();
        await releaseEarlier.promise;
      }
      return undefined;
    });
    const sourceWork: Promise<unknown>[] = [];

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const earlier = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 440,
        messageId: 440,
        text: "earlier active message",
        replayUpdate: "full",
      });
      earlierWork = requireValue(earlier.deferredWork, "earlier source participant").task;
      await vi.advanceTimersByTimeAsync(3000);
      await earlierStarted.promise;
      const ordinary = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 441,
        messageId: 441,
        text: "A".repeat(611),
        replayUpdate: "full",
      });
      const ordinaryParticipant = requireValue(
        ordinary.deferredWork,
        "ordinary source participant",
      );
      sourceWork.push(ordinaryParticipant.task);
      const forwarded = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 442,
        messageId: 442,
        text: "F".repeat(611),
        message: { forward_date: 1736380700 },
        replayUpdate: "full",
      });
      const forwardedParticipant = requireValue(
        forwarded.deferredWork,
        "forwarded source participant",
      );
      sourceWork.push(forwardedParticipant.task);
      await vi.advanceTimersByTimeAsync(80);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["440"]);

      resolveMedia.mockResolvedValueOnce({
        id: "caption-fixture",
        fileUniqueId: "caption-document-unique",
        path: attachmentPath,
        size: 10,
        contentType: "text/plain",
        kind: "document",
        savedAt: 1736380800000,
      });
      await dispatchPrivateText(messageHandler, {
        updateId: 443,
        messageId: 443,
        text: "",
        message: {
          text: undefined,
          caption: "stop",
          document: {
            file_id: "caption-document",
            file_unique_id: "caption-document-unique",
            file_name: "caption.txt",
            mime_type: "text/plain",
          },
        },
      });

      expect(ordinaryParticipant.isSettled()).toBe(true);
      expect(forwardedParticipant.isSettled()).toBe(true);
      await expect(Promise.all(sourceWork)).resolves.toEqual([
        { kind: "skipped" },
        { kind: "skipped" },
      ]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["440", "443"]);
      releaseEarlier.resolve();
      await expect(earlierWork).resolves.toEqual({ kind: "completed" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["440", "443"]);
    } finally {
      releaseEarlier.resolve();
      await earlierWork;
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(sourceWork);
      vi.useRealTimers();
      resolveMedia.mockRestore();
    }
  });

  it("native stop cancels pending input before configured binding preparation finishes", async () => {
    installTelegramTopicStateForTest();
    const topic = {
      chat: { id: -1001234567890, type: "supergroup", title: "Bound topic", is_forum: true },
      message_thread_id: 42,
      is_topic_message: true,
    };
    loadConfig.mockReturnValue({
      commands: { native: true, allowFrom: { telegram: ["42"] } },
      messages: { inbound: { byChannel: { telegram: 3000 } } },
      channels: { telegram: { groupPolicy: "open", groups: { "*": { requireMention: false } } } },
    });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    const preparationStarted = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    let sourceWork: Promise<unknown> | undefined;
    let stopDispatch: ReturnType<typeof dispatchSpooledNativeStop> | undefined;
    const bindingRoute = vi.spyOn(bindingRuntime, "resolveConfiguredBindingRoute");
    const bindingReady = vi.spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady");

    try {
      await createTelegramBot({ token: "tok" });
      const pending = await dispatchSpooledPrivateText(getMessageHandler(), {
        updateId: 451,
        messageId: 451,
        text: "H".repeat(4065),
        message: topic,
        replayUpdate: "full",
      });
      const participant = requireValue(pending.deferredWork, "pending source participant");
      sourceWork = participant.task;
      bindingRoute.mockImplementation(({ route }) =>
        createConfiguredBindingRoute(
          route,
          createConfiguredAcpTopicBinding("agent:main:acp:binding:telegram:default:held"),
        ),
      );
      bindingReady.mockImplementationOnce(async () => {
        preparationStarted.resolve();
        await releasePreparation.promise;
        return { ok: false, error: "binding unavailable" };
      });

      stopDispatch = dispatchSpooledNativeStop({ updateId: 452, messageId: 452, message: topic });
      await preparationStarted.promise;

      expect(participant.isSettled()).toBe(true);
      await expect(participant.task).resolves.toEqual({ kind: "skipped" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(replySpy).not.toHaveBeenCalled();
      releasePreparation.resolve();
      await stopDispatch;
      expect(sendMessageSpy).not.toHaveBeenCalled();
    } finally {
      releasePreparation.resolve();
      await stopDispatch;
      bindingRoute.mockRestore();
      bindingReady.mockRestore();
      await vi.advanceTimersByTimeAsync(3000);
      await sourceWork;
      vi.useRealTimers();
      clearTelegramRuntimeForTest();
      resetTelegramTopicNameCacheForTest();
    }
  });

  it("keeps separate text-batch replay settlements isolated when the next batch fails", async () => {
    configureOpenDm({ debounceMs: 300, timezone: "envelopeTimezone" });
    installPerKeySequentializer();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const secondDispatchError = new Error("next batch failed before adoption");
    replySpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(secondDispatchError);
    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const first = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 213,
        messageId: 213,
        text: "A".repeat(4050),
        replayUpdate: "full",
      });
      await vi.advanceTimersByTimeAsync(1500);
      const firstParticipant = requireValue(first.deferredWork, "first batch participant");
      await expect(firstParticipant.task).resolves.toEqual({ kind: "completed" });
      const second = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 214,
        messageId: 215,
        text: "next message",
        replayUpdate: "full",
      });
      await vi.advanceTimersByTimeAsync(300);
      const secondParticipant = requireValue(second.deferredWork, "second batch participant");
      expect(secondParticipant).not.toBe(firstParticipant);
      await expect(secondParticipant.task).resolves.toEqual({
        kind: "failed-retryable",
        error: secondDispatchError,
      });
      await expect(firstParticipant.task).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "A".repeat(4050),
        "next message",
      ]);
      expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["213", "215"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries deferred adoption after durable commit fails without settling buffered participants", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const commitError = new Error("durable dispatch commit failed");
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockRejectedValueOnce(commitError);
    let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedLifecycle = opts?.turnAdoptionLifecycle;
      queuedLifecycle?.onDeferred?.();
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const firstReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 221,
        messageId: 221,
        text: "first buffered message",
        date: 1736381021,
      });
      const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 222,
        messageId: 222,
        text: "second buffered message",
        date: 1736381022,
      });
      const firstParticipant = requireValue(
        firstReplay.deferredWork,
        "first buffered replay participant",
      );
      const secondParticipant = requireValue(
        secondReplay.deferredWork,
        "second buffered replay participant",
      );
      let firstSettled = false;
      let secondSettled = false;
      void firstParticipant.task.then(() => {
        firstSettled = true;
      });
      void secondParticipant.task.then(() => {
        secondSettled = true;
      });

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await vi.waitFor(() => {
        expect(queuedLifecycle?.onAdopted).toEqual(expect.any(Function));
      });

      await expect(queuedLifecycle?.onAdopted?.()).rejects.toBe(commitError);
      await flushTelegramTestMicrotasks();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      await queuedLifecycle?.onAdopted?.();
      await expect(Promise.all([firstParticipant.task, secondParticipant.task])).resolves.toEqual([
        { kind: "completed" },
        { kind: "completed" },
      ]);
      expect(commitSpy).toHaveBeenCalledTimes(2);
      queuedLifecycle?.onSettled?.();
    } finally {
      commitSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("serializes timeout settlement behind an in-flight durable adoption commit", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let markCommitStarted: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockImplementationOnce(async () => {
        markCommitStarted?.();
        await commitGate;
      });
    const releaseSpy = vi.spyOn(messageDispatchDedupe, "releaseTelegramMessageDispatchReplay");
    let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
    let queuedAbortSignal: AbortSignal | undefined;
    let runQueuedTurn: (() => Promise<void>) | undefined;
    let modelTurnRan = false;
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedLifecycle = opts?.turnAdoptionLifecycle;
      queuedAbortSignal = opts?.abortSignal;
      queuedLifecycle?.onDeferred?.();
      runQueuedTurn = async () => {
        await queuedLifecycle?.onAdopted?.();
        if (queuedAbortSignal?.aborted) {
          throw queuedAbortSignal.reason;
        }
        modelTurnRan = true;
        queuedLifecycle?.onSettled?.();
      };
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const firstReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 225,
        messageId: 225,
        text: "first buffered message",
        date: 1736381025,
      });
      const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 226,
        messageId: 226,
        text: "second buffered message",
        date: 1736381026,
      });
      const firstParticipant = requireValue(
        firstReplay.deferredWork,
        "first buffered replay participant",
      );
      const secondParticipant = requireValue(
        secondReplay.deferredWork,
        "second buffered replay participant",
      );

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await vi.waitFor(() => {
        expect(runQueuedTurn).toEqual(expect.any(Function));
      });

      const queuedTurn = runQueuedTurn?.();
      await commitStarted;
      const timeoutError = new Error("spooled replay timed out during durable adoption");
      let firstParticipantSettled = false;
      void firstParticipant.task.then(() => {
        firstParticipantSettled = true;
      });
      firstParticipant.settle({ kind: "failed-retryable", error: timeoutError });
      await flushTelegramTestMicrotasks();
      expect(firstParticipantSettled).toBe(false);
      expect(firstParticipant.abortSignal.aborted).toBe(false);
      expect(releaseSpy).not.toHaveBeenCalled();

      releaseCommit?.();
      await queuedTurn;
      expect(modelTurnRan).toBe(true);
      expect(queuedAbortSignal?.aborted).toBe(false);
      await expect(Promise.all([firstParticipant.task, secondParticipant.task])).resolves.toEqual([
        { kind: "completed" },
        { kind: "completed" },
      ]);
      expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).not.toHaveBeenCalled();
    } finally {
      releaseCommit?.();
      commitSpy.mockRestore();
      releaseSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("blocks buffered adoption after an exposed replay participant times out", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const commitSpy = vi.spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay");
    let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
    let queuedAbortSignal: AbortSignal | undefined;
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedLifecycle = opts?.turnAdoptionLifecycle;
      queuedAbortSignal = opts?.abortSignal;
      queuedLifecycle?.onDeferred?.();
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const firstReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 223,
        messageId: 223,
        text: "first buffered message",
        date: 1736381023,
      });
      const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 224,
        messageId: 224,
        text: "second buffered message",
        date: 1736381024,
      });
      const firstParticipant = requireValue(
        firstReplay.deferredWork,
        "first buffered replay participant",
      );
      const secondParticipant = requireValue(
        secondReplay.deferredWork,
        "second buffered replay participant",
      );

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await vi.waitFor(() => {
        expect(queuedLifecycle?.onAdopted).toEqual(expect.any(Function));
      });

      const timeoutError = new Error("spooled replay timed out before admission");
      firstParticipant.settle({ kind: "failed-retryable", error: timeoutError });
      await vi.waitFor(() => {
        expect(queuedAbortSignal?.aborted).toBe(true);
      });
      await expect(secondParticipant.task).resolves.toEqual({
        kind: "failed-retryable",
        error: timeoutError,
      });
      await expect(queuedLifecycle?.onAdopted?.()).rejects.toBe(timeoutError);
      expect(commitSpy).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
    } finally {
      commitSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("dispatches native poll messages through the ordinary inbound handler", async () => {
    loadConfig.mockReturnValue({ channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } } });
    replySpy.mockClear();
    await createTelegramBot({ token: "tok" });

    await getMessageHandler()(
      makePrivateTextContext({
        text: "",
        messageId: 551,
        message: {
          text: undefined,
          poll: {
            id: "poll-551",
            question: "Approve deployment?",
            options: [
              { persistent_id: "yes", text: "Yes", voter_count: 3 },
              { persistent_id: "no", text: "No", voter_count: 0 },
            ],
            total_voter_count: 3,
            is_closed: false,
            is_anonymous: false,
            type: "regular",
            allows_multiple_answers: false,
          },
        },
      }),
    );

    expect(replySpy).toHaveBeenCalledOnce();
    const payload = requireValue(replySpy.mock.calls[0]?.[0], "inbound poll payload");
    expect(payload.BodyForAgent).toContain("[Poll] Approve deployment?");
    expect(payload.BodyForAgent).toContain("1. Yes — 3 votes");
    expect(payload.BodyForAgent).toContain("2. No — 0 votes");
    expect(payload.BodyForAgent).toContain("Total voters: 3");
  });

  it("preserves formatting entities through the forwarded-message debounce boundary", async () => {
    configureOpenDm({ timezone: "envelopeTimezone" });
    replySpy.mockClear();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const sourceWork: Promise<unknown>[] = [];
    let flushForward: (() => void) | undefined;

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      for (const [messageId, text, entities, origin] of [
        [561, "😀 bold", [{ type: "bold", offset: 3, length: 4 }], "Original A"],
        [
          562,
          "read docs",
          [{ type: "text_link", offset: 5, length: 4, url: "https://docs.example" }],
          "Original B",
        ],
      ] as const) {
        const replay = await dispatchSpooledPrivateText(messageHandler, {
          updateId: messageId,
          text,
          messageId,
          date: 1736380800 + messageId,
          replayUpdate: "full",
          message: {
            entities,
            forward_origin: {
              type: "hidden_user",
              date: 500 + messageId,
              sender_user_name: origin,
            },
          },
        });
        sourceWork.push(requireValue(replay.deferredWork, "forwarded source participant").task);
        flushForward = takeLatestTimerCallback(80);
      }

      requireValue(flushForward, "forwarded debounce callback")();
      await Promise.all(sourceWork);
      expect(replySpy).toHaveBeenCalledOnce();
      const payload = requireValue(
        replySpy.mock.calls[0]?.[0],
        "formatted forwarded batch payload",
      );
      expect(payload.RawBody).toBe("😀 **bold**\nread [docs](https://docs.example)");
      expect(payload.BodyForAgent).toContain("😀 **bold**");
      expect(payload.BodyForAgent).toContain("read [docs](https://docs.example)");
      expect(payload.BodyForAgent).toContain("[Forwarded from Original A");
      expect(payload.BodyForAgent).toContain("[Forwarded from Original B");
      expect(payload.CommandBody).toBe("😀 **bold**\nread [docs](https://docs.example)");
      expect(payload.BodyForAgent).toMatch(
        /\[Forwarded from Original A[^\]]*\]\n😀 \*\*bold\*\*\n\[Forwarded from Original B[^\]]*\]\nread \[docs\]\(https:\/\/docs\.example\)/,
      );
      expect(payload.BodyForAgent).not.toContain("Conversation info:");
      expect(payload.ForwardedFrom).toBeUndefined();
    } finally {
      flushForward?.();
      await Promise.allSettled(sourceWork);
      setTimeoutSpy.mockRestore();
    }
  });

  it("preserves structured origin for a single forwarded debounce entry", async () => {
    configureOpenDm({ timezone: "envelopeTimezone" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const sourceWork: Promise<unknown>[] = [];
    let flushForward: (() => void) | undefined;

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const replay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 121,
        text: "single forwarded note",
        messageId: 121,
        date: 1736380921,
        replayUpdate: "full",
        message: {
          forward_origin: {
            type: "hidden_user",
            date: 621,
            sender_user_name: "Original A",
          },
        },
      });
      sourceWork.push(requireValue(replay.deferredWork, "forwarded source participant").task);

      flushForward = takeLatestTimerCallback(80);
      flushForward();

      await Promise.all(sourceWork);
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = requireValue(replySpy.mock.calls[0]?.[0], "single forwarded payload");
      expect(payload.Body).toContain("[Forwarded from Original A");
      expect(payload.ForwardedFrom).toBe("Original A");
    } finally {
      flushForward?.();
      await Promise.allSettled(sourceWork);
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not let an unauthorized group stop cancel pending text", async () => {
    const text = "B".repeat(4065);
    const chatId = nextForumCacheChatId();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: INBOUND_DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    installPerKeySequentializer();

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    let pendingWork: Promise<unknown> | undefined;

    try {
      await createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const pending = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 104,
        messageId: 104,
        text,
        date: 1736380804,
        replayUpdate: "full",
        message: {
          chat: { id: chatId, type: "supergroup", title: "OpenClaw Ops" },
          from: { id: 42, first_name: "Ada", is_bot: false },
        },
      });
      pendingWork = requireValue(pending.deferredWork, "pending group participant").task;

      await runTelegramMiddlewareChain({
        ctx: {
          update: { update_id: 105 },
          message: {
            chat: { id: chatId, type: "supergroup", title: "OpenClaw Ops" },
            text: "stop",
            date: 1736380805,
            message_id: 105,
            from: { id: 42, first_name: "Ada" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        },
        finalHandler: messageHandler,
      });

      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS);
      await expect(pendingWork).resolves.toEqual({ kind: "completed" });
      expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toContain(text);
    } finally {
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS);
      await pendingWork;
      vi.useRealTimers();
    }
  });

  it("routes generic callback_query payloads as callback_data messages and answers callbacks", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({ id: "cbq-1", data: "cmd:option_a", messageId: 10 }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("callback_data: cmd:option_a");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-1");
  });

  it.each([
    { name: "raw", data: "code-agent:approve-123", payload: "approve-123" },
    {
      name: "opaque with trailing whitespace",
      data: buildTelegramOpaqueCallbackData("code-agent:approve-123 "),
      payload: "approve-123",
    },
  ])(
    "routes $name plugin callback_query payloads without fallback callback_data text",
    async ({ data, payload }) => {
      const pluginHandler = vi.fn(async (ctx) => {
        expect(ctx.callback.namespace).toBe("code-agent");
        expect(ctx.callback.payload).toBe(payload);
        await ctx.respond.clearButtons();
        return { handled: true };
      });
      expect(
        registerPluginInteractiveHandler("openclaw-code-agent", {
          channel: "telegram",
          namespace: "code-agent",
          handler: pluginHandler,
        }),
      ).toEqual({ ok: true });

      await createTelegramBot({ token: "tok" });
      const callbackHandler = getCallbackHandler();
      await callbackHandler(
        makeCallbackRetryContext({
          id: "cbq-plugin-1",
          data,
          messageId: 10,
          text: "Approve this code-agent action?",
          message: {
            reply_markup: {
              inline_keyboard: [[{ text: "Approve", callback_data: data }]],
            },
          },
        }),
      );

      expect(pluginHandler).toHaveBeenCalledTimes(1);
      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
        reply_markup: { inline_keyboard: [] },
      });
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-1");
    },
  );

  it("preserves raw tgcb1 callbacks emitted before the prefix became reserved", async () => {
    const pluginHandler = vi.fn(async (ctx) => {
      expect(ctx.callback.namespace).toBe("tgcb1");
      expect(ctx.callback.payload).toBe("inspect:123");
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler("legacy-tgcb1", {
        channel: "telegram",
        namespace: "tgcb1",
        handler: pluginHandler,
      }),
    ).toEqual({ ok: true });

    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-legacy-tgcb1",
        data: "tgcb1:inspect:123",
        messageId: 10,
      }),
    );

    expect(pluginHandler).toHaveBeenCalledOnce();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      1234,
      "This action is no longer available.",
      undefined,
    );
  });

  it("preserves raw slash callback_query payloads as command text", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({ id: "cbq-slash-1", data: "/fast status", messageId: 10 }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("/fast status");
    expect(payload.Body).not.toContain("callback_data: /fast status");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-slash-1");
  });

  it.each([
    { name: "clears buttons", id: "cbq-generic-clear-1", editError: undefined },
    {
      name: "continues after a permanent edit error",
      id: "cbq-generic-clear-permanent-1",
      editError: new Error("400: Bad Request: message can't be edited"),
    },
  ])("routes generic callback_query payloads and $name", async ({ id, editError }) => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    if (editError) {
      editMessageReplyMarkupSpy.mockRejectedValueOnce(editError);
    }

    await callbackHandler(makeGenericCallbackContext({ id }));

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("skip nightly build tonight");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith(id);
  });

  it("retries generic callback_query button cleanup after transient edit failures", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const ctx = makeGenericCallbackContext({ id: "cbq-generic-clear-retry-1", updateId: 779 });

    editMessageReplyMarkupSpy.mockRejectedValueOnce(new Error("edit boom"));

    await expect(
      runTelegramMiddlewareChain({
        ctx,
        finalHandler: callbackHandler,
      }),
    ).rejects.toThrow("edit boom");
    expect(replySpy).not.toHaveBeenCalled();

    await runTelegramMiddlewareChain({
      ctx,
      finalHandler: callbackHandler,
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(2);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("skip nightly build tonight");
  });

  it("does not route opaque callback_query payloads as synthetic commands", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-opaque-1",
        data: buildTelegramOpaqueCallbackData("/codex permissions yolo"),
        messageId: 10,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-opaque-1");
  });

  it.each([
    { name: "delimited", value: "env|prod" },
    { name: "trailing-whitespace", value: "env|prod " },
  ])(
    "toggles $name OC_MULTI buttons without routing through generic messages",
    async ({ value }) => {
      const data = `OC_MULTI|toggle|${value}`;
      await createTelegramBot({ token: "tok" });
      const callbackHandler = getCallbackHandler();
      await callbackHandler(
        makeCallbackRetryContext({
          id: "cbq-multi-toggle-1",
          data,
          messageId: 10,
          message: {
            business_connection_id: "biz-multi-1",
            reply_markup: {
              inline_keyboard: [[{ text: "Prod", callback_data: data }]],
            },
          },
        }),
      );

      expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
        business_connection_id: "biz-multi-1",
        reply_markup: {
          inline_keyboard: [[{ text: "✅ Prod", callback_data: data }]],
        },
      });
      expect(replySpy).not.toHaveBeenCalled();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-multi-toggle-1");
    },
  );

  it("submits OC_MULTI selections as a synthetic inbound message", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-multi-submit-1",
        data: "OC_MULTI|submit",
        messageId: 10,
        message: {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Prod", callback_data: "OC_MULTI|toggle|env|prod" }],
              [{ text: "Blue", callback_data: "OC_MULTI|toggle|blue" }],
            ],
          },
        },
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].Body).toContain(
      "Multi-select submitted: env|prod",
    );
  });

  it("submits OC_SELECT values as a synthetic inbound message and clears buttons", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-select-1",
        data: "OC_SELECT|env|canary",
        messageId: 10,
        message: {
          reply_markup: {
            inline_keyboard: [[{ text: "Canary", callback_data: "OC_SELECT|env|canary" }]],
          },
        },
      }),
    );

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].Body).toContain(
      "Single-select submitted: env|canary",
    );
  });

  it("keeps tgcmd native when a plugin registers the same namespace", async () => {
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    expect(
      registerPluginInteractiveHandler("namespace-collision", {
        channel: "telegram",
        namespace: "tgcmd",
        handler: pluginHandler,
      }),
    ).toEqual({ ok: true });

    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-native-collision",
        data: "tgcmd:/fast status",
        messageId: 10,
      }),
    );

    expect(pluginHandler).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0]).toMatchObject({
      CommandBody: "/fast status",
      CommandSource: "native",
    });
  });

  it.each([
    ["ordinary native command", "tgcmd:/fast status"],
    ["native Codex login", "tgcmd:/login codex"],
  ])("terminalizes %s callbacks after inline buttons are disabled", async (_name, data) => {
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    registerPluginInteractiveHandler("disabled-native-collision", {
      channel: "telegram",
      namespace: "tgcmd",
      handler: pluginHandler,
    });
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: { inlineButtons: "off" },
        },
      },
    });

    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-disabled-native",
        data,
        messageId: 10,
        message: {
          reply_markup: {
            inline_keyboard: [[{ text: "Action", callback_data: data }]],
          },
        },
      }),
    );

    expect(pluginHandler).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "This action is no longer available.",
      undefined,
    );
  });

  it("keeps the login action when the callback sender is not an owner", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      commands: { native: true, ownerAllowFrom: ["999"] },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: "cbq-login-nonowner",
        data: "tgcmd:/login codex",
        messageId: 10,
        message: {
          reply_markup: {
            inline_keyboard: [[{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }]],
          },
        },
      }),
    );

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
      {},
    );
  });

  it("lets an owner start Codex login from a pairing-policy DM callback", async () => {
    const runModelsAuthLoginFlow = vi
      .spyOn(defaultTelegramNativeCommandDeps, "runModelsAuthLoginFlow")
      .mockImplementation(async (params) => {
        await params.prompter.deviceCode?.({
          title: "OpenAI Codex device code",
          code: "OWNER-CODE",
          message: "URL: https://auth.openai.com/codex/device",
        });
        return {
          providerId: "openai",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
        };
      });
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      commands: { native: true, ownerAllowFrom: ["9"] },
      channels: { telegram: { dmPolicy: "pairing" } },
      agents: { list: [{ id: "main", default: true }] },
    });

    try {
      await createTelegramBot({ token: "tok" });
      await getCallbackHandler()(
        makeCallbackRetryContext({
          id: "cbq-login-owner",
          data: "tgcmd:/login codex",
          messageId: 10,
          message: {
            reply_markup: {
              inline_keyboard: [[{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }]],
            },
          },
        }),
      );

      expect(runModelsAuthLoginFlow).toHaveBeenCalledOnce();
      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        expect.stringContaining("Code: <code>OWNER-CODE</code>"),
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    } finally {
      runModelsAuthLoginFlow.mockRestore();
    }
  });

  it.each([
    ["stale", buildTelegramOpaqueCallbackData("missing-plugin:approve-1")],
    ["malformed", "tgcb1:invalid"],
  ])("terminalizes %s typed callbacks without raw-text fallthrough", async (_name, data) => {
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    registerPluginInteractiveHandler("disabled-typed-owner", {
      channel: "telegram",
      namespace: "missing-plugin",
      handler: pluginHandler,
    });
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: { inlineButtons: "off" },
        },
      },
    });
    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()(
      makeCallbackRetryContext({
        id: `cbq-opaque-${_name}`,
        data,
        messageId: 10,
        message: {
          reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: data }]] },
        },
      }),
    );

    expect(pluginHandler).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "This action is no longer available.",
      undefined,
    );
  });

  it("handles pairing DM flows for new and already-pending requests", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest
      .mockResolvedValue({ code: "PAIRCODE", created: false })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true });

    await createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    const senderId = Number(`${Date.now()}1`.slice(-9));
    for (const text of ["hello", "hello again"]) {
      await handler(
        makePrivateTextContext({
          chatId: 1234,
          text,
          from: { id: senderId, username: "random" },
          downloadable: true,
        }),
      );
    }

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls.at(0)?.[0]).toBe(1234);
    const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
    expect(pairingText).toContain(`Your Telegram user id: ${senderId}`);
    expect(pairingText).toContain("Pairing code:");
    expect(pairingText).toContain("openclaw pairing approve telegram");
    expectRecordFields(
      sendMessageSpy.mock.calls.at(0)?.[2],
      { parse_mode: "HTML" },
      "pairing reply options",
    );
  });

  it("marks spooled replay pairing store read failures retryable without apology spam", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    sendMessageSpy.mockClear();
    const onUpdateId = vi.fn();

    await createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 700,
        onUpdateId,
      },
    });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = {
      update_id: 701,
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        message_id: 9,
        date: 1736380800,
        from: { id: 123456789, username: "testuser" },
      },
    };
    const ctx = {
      update,
      message: update.message,
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await expect(
      withTelegramSpooledReplayUpdate(update, async () => {
        await runTelegramMiddlewareChain({
          ctx,
          finalHandler: async () => {
            await handler(ctx);
          },
        });
      }),
    ).rejects.toMatchObject({
      name: TelegramSpooledReplayProcessingError.name,
      cause: expect.objectContaining({ name: "TelegramPairingStoreReadError" }),
    });

    expect(onUpdateId).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("keeps the same private chat usable after a transient pairing store read failure", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore
      .mockRejectedValueOnce(new Error("store temporarily unavailable"))
      .mockResolvedValueOnce(["123456789"]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    const sender = { id: 123456789, username: "testuser" };
    await handler(
      makePrivateTextContext({
        chatId: 1234,
        text: "hello",
        messageId: 10,
        from: sender,
        downloadable: true,
      }),
    );
    await handler(
      makePrivateTextContext({
        chatId: 1234,
        text: "still there?",
        messageId: 11,
        date: 1736380801,
        from: sender,
        downloadable: true,
      }),
    );

    expect(readChannelAllowFromStore).toHaveBeenCalledTimes(2);
    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    // First message: failure → retry hint via sendMessageSpy. Second message: success → agent reply via replySpy.
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toMatch(/please try again/i);
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows a configured private sender when the pairing allowlist store cannot be read", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "pairing", allowFrom: ["123456789"] } },
    });
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        date: 1736380800,
        from: { id: 123456789, username: "testuser" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(readChannelAllowFromStore).not.toHaveBeenCalled();
    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("does not require the pairing allowlist store for open private messages", async () => {
    configureOpenDm();
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        date: 1736380800,
        from: { id: 123456789, username: "testuser" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(readChannelAllowFromStore).not.toHaveBeenCalled();
    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("ignores private self-authored message updates instead of issuing a pairing challenge", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private", first_name: "Harold" },
        message_id: 1884,
        date: 1736380800,
        from: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
        pinned_message: {
          message_id: 1883,
          date: 1736380799,
          chat: { id: 1234, type: "private", first_name: "Harold" },
          from: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
          text: "Binding: Review pull request 54118 (openclaw)",
        },
      },
      me: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("does not leak blocked allowlist text DMs into authorized prompt context", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 411,
        date: 1736380800,
        text: "unauthorized secret",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).not.toHaveBeenCalled();

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 412,
        date: 1736380860,
        text: "authorized follow-up",
        from: { id: 123456789, username: "allowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext).toBeUndefined();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("does not cache blocked allowlist edited DMs into authorized prompt context", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await editedHandler({
      editedMessage: {
        chat: { id: 1234, type: "private" },
        message_id: 414,
        date: 1736380800,
        edit_date: 1736380810,
        text: "edited unauthorized secret",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).not.toHaveBeenCalled();

    await messageHandler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 415,
        date: 1736380860,
        text: "authorized follow-up",
        from: { id: 123456789, username: "allowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext).toBeUndefined();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("does not cache blocked group-sender edits into authorized prompt context", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
          groups: { "*": { requireMention: false } },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await editedHandler({
      editedMessage: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        message_id: 416,
        date: 1736380800,
        edit_date: 1736380810,
        text: "edited unauthorized group secret",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).not.toHaveBeenCalled();

    await messageHandler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        message_id: 417,
        date: 1736380860,
        text: "authorized follow-up",
        from: { id: 123456789, username: "allowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext).toBeUndefined();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("drops topic-required root DMs before pairing challenges", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          direct: {
            "1234": { requireTopic: true },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 413,
        date: 1736380870,
        text: "root dm without topic",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("blocks DM media downloads completely when dmPolicy is disabled", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "disabled" } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      await createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 411,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: 999, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("blocks unauthorized DM media before download and sends pairing reply", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}01`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      await createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 410,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: senderId, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("Pairing code:");
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("blocks unauthorized DM media groups before any photo download", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}02`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      await createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 412,
          media_group_id: "dm-album-1",
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: senderId, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expectRecordFields(
        sendMessageSpy.mock.calls.at(0)?.[2],
        { parse_mode: "HTML" },
        "album pairing reply options",
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("dedupes duplicate updates for callback_query, message, and channel_post", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const channelPostHandler = getOnHandler("channel_post") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const callbackCtx = (id: string, data: string) =>
      makeCallbackRetryContext({
        updateId: 222,
        id,
        data,
        messageId: 9001,
        from: { id: 789, username: "testuser" },
        message: { chat: { id: 123, type: "private" } },
      });
    const resolveQuestion = vi
      .spyOn(questionGatewayRuntime, "resolveOption")
      .mockRejectedValue(new Error("Unexpected duplicate question resolution"));
    try {
      // Admission owns dedupe state; the duplicate handler must still acknowledge its button.
      await runTelegramMiddlewareChain({
        ctx: callbackCtx("cb-1", "ping"),
        finalHandler: callbackHandler,
      });
      await callbackHandler(
        callbackCtx("cb-question-duplicate", "tgq1:ask_0123456789abcdef0123456789abcdef:1"),
      );
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cb-question-duplicate");
      expect(resolveQuestion).not.toHaveBeenCalled();
    } finally {
      resolveQuestion.mockRestore();
    }

    replySpy.mockClear();

    await messageHandler({
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    await messageHandler({
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await channelPostHandler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
        message_id: 777,
        text: "wake check",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    await channelPostHandler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
        message_id: 777,
        text: "wake check",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes a replayed Telegram message after handler recreation", async () => {
    configureOpenDm();

    const replayedCtx = () => ({
      update: { update_id: 8488601 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "replay me once",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    await createTelegramBot({ token: "tok" });
    await (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );
    expect(replySpy).toHaveBeenCalledTimes(1);

    onSpy.mockClear();
    await createTelegramBot({ token: "tok" });
    await (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes a replayed Telegram message after handler recreation while dispatch is pending", async () => {
    configureOpenDm();

    const firstDispatchStarted = createDeferred<void>();
    const finishFirstDispatch = createDeferred<void>();
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      firstDispatchStarted.resolve();
      await finishFirstDispatch.promise;
      return undefined;
    });

    const replayedCtx = () => ({
      update: { update_id: 8488602 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "replay while pending",
        date: 1736380800,
        message_id: 43,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    await createTelegramBot({ token: "tok" });
    const firstRun = (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );
    await firstDispatchStarted.promise;
    expect(replySpy).toHaveBeenCalledTimes(1);

    onSpy.mockClear();
    await createTelegramBot({ token: "tok" });
    await (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    finishFirstDispatch.resolve();
    await firstRun;
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("retries a spooled message after dispatch fails before turn adoption", async () => {
    configureOpenDm();
    const dispatchError = new Error("failed before turn adoption");
    replySpy.mockRejectedValueOnce(dispatchError).mockResolvedValueOnce({ text: "recovered" });

    await createTelegramBot({ token: "tok" });
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const replayedCtx = () => {
      const message = {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "retry after pre-adoption failure",
        date: 1736380800,
        message_id: 44,
      };
      const update = { update_id: 8488603, message };
      return {
        update,
        message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };
    };

    const firstCtx = replayedCtx();
    const firstReplay = await runWithTelegramSpooledReplayUpdate(firstCtx.update, async () => {
      await runTelegramMiddlewareChain({
        ctx: firstCtx,
        finalHandler: messageHandler,
      });
    });
    const firstDeferredWork = requireValue(firstReplay.deferredWork, "first replay deferred work");
    await expect(firstDeferredWork.task).resolves.toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
    await flushTelegramTestMicrotasks();

    const secondCtx = replayedCtx();
    const secondReplay = await runWithTelegramSpooledReplayUpdate(secondCtx.update, async () => {
      await runTelegramMiddlewareChain({
        ctx: secondCtx,
        finalHandler: messageHandler,
      });
    });
    const secondDeferredWork = requireValue(
      secondReplay.deferredWork,
      "second replay deferred work",
    );
    await expect(secondDeferredWork.task).resolves.toEqual({ kind: "completed" });
    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("persists recorded dispatch failures during normal polling", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 500,
    });

    const dispatchError = new Error("dispatch exploded");
    await runMiddlewareChain({ update: { update_id: 501 } }, async () => {
      recordTelegramMessageProcessingResult({
        kind: "failed-retryable",
        error: dispatchError,
      });
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501]);

    await runMiddlewareChain({ update: { update_id: 502 } }, async () => {});
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501, 502]);
  });

  it("rejects recorded dispatch failures during isolated spool replay", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 600,
    });

    const update = { update_id: 601 };
    const dispatchError = new Error("dispatch exploded");
    await expect(
      withTelegramSpooledReplayUpdate(update, async () => {
        await runMiddlewareChain({ update }, async () => {
          recordTelegramMessageProcessingResult({
            kind: "failed-retryable",
            error: dispatchError,
          });
        });
      }),
    ).rejects.toMatchObject({
      name: TelegramSpooledReplayProcessingError.name,
      cause: dispatchError,
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();
  });

  it("retries a deferred spooled update after its queued turn is abandoned", async () => {
    configureOpenDm();
    // The first dispatch hydrates the per-test message cache before getReply
    // runs; wait on the lifecycle itself instead of racing a polling timeout.
    const queuedLifecycleReady = createDeferred<GetReplyOptions["turnAdoptionLifecycle"]>();
    replySpy
      .mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        opts?.turnAdoptionLifecycle?.onDeferred?.();
        queuedLifecycleReady.resolve(opts?.turnAdoptionLifecycle);
        return undefined;
      })
      .mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        await opts?.turnAdoptionLifecycle?.onAdopted?.();
        return { text: "recovered" };
      });
    const { onUpdateId } = await setupUpdateOffsetTracker({
      lastUpdateId: 701,
    });
    const messageHandler = getMessageHandler();

    const firstReplayPromise = dispatchSpooledPrivateText(messageHandler, {
      updateId: 702,
      messageId: 702,
      text: "retry after queued turn abandonment",
    });
    const queuedLifecycle = await queuedLifecycleReady.promise;
    expect(queuedLifecycle?.onAbandoned).toEqual(expect.any(Function));
    queuedLifecycle?.onAbandoned?.();
    const firstReplay = await firstReplayPromise;
    const firstDeferredWork = requireValue(firstReplay.deferredWork, "first deferred spooled work");
    await expect(firstDeferredWork.task).resolves.toMatchObject({ kind: "failed-retryable" });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
      updateId: 702,
      messageId: 702,
      text: "retry after queued turn abandonment",
    });
    const secondDeferredWork = requireValue(
      secondReplay.deferredWork,
      "second deferred spooled work",
    );
    await expect(secondDeferredWork.task).resolves.toEqual({ kind: "completed" });
    await flushTelegramTestMicrotasks();
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([702]);

    const duplicateReplay = await dispatchSpooledPrivateText(messageHandler, {
      updateId: 702,
      messageId: 702,
      text: "retry after queued turn abandonment",
    });
    expect(duplicateReplay.deferredWork).toBeUndefined();
    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("allows distinct callback_query ids without update_id", async () => {
    configureOpenDm();

    await createTelegramBot({ token: "tok" });
    const handler = getCallbackHandler();
    for (const id of ["cb-1", "cb-2"]) {
      await handler(
        makeCallbackRetryContext({
          id,
          data: "ping",
          messageId: 9001,
          from: { id: 789, username: "testuser" },
          message: { chat: { id: 123, type: "private" } },
          downloadable: false,
        }),
      );
    }

    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("reloads DM routing bindings between messages without recreating the bot", async () => {
    let boundAgentId = "agent-a";
    const configForAgent = (agentId: string) => ({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "tok-work",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
      agents: {
        list: [{ id: "agent-a", default: true }, { id: "agent-b" }],
      },
      bindings: [
        {
          agentId,
          match: { channel: "telegram", accountId: "opie" },
        },
      ],
    });
    loadConfig.mockImplementation(() => configForAgent(boundAgentId));

    await createTelegramBot({ token: "tok", accountId: "opie" });
    const handler = getMessageHandler();

    const sendDm = async (messageId: number, text: string) => {
      await handler(
        makePrivateTextContext({
          chatId: 123,
          from: { id: 999, username: "testuser" },
          text,
          date: 1736380800 + messageId,
          messageId,
          downloadable: true,
        }),
      );
    };

    await sendDm(42, "hello one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await sendDm(43, "hello two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls.at(1)?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("agent:agent-b:");
  });

  it("reloads topic agent overrides between messages without recreating the bot", async () => {
    let topicAgentId = "topic-a";
    const configForTopicAgent = () => ({
      session: {
        typingMode: "never",
      },
      messages: {
        inbound: {
          debounceMs: 0,
        },
      },
      channels: {
        telegram: {
          botToken: "tok",
          dmPolicy: "open",
          allowFrom: ["*"],
          direct: {
            "123": {
              topics: {
                "99": {
                  agentId: topicAgentId,
                },
              },
            },
            "124": {
              topics: {
                "99": {
                  agentId: topicAgentId,
                },
              },
            },
          },
        },
      },
      agents: {
        list: [{ id: "topic-a", default: true }, { id: "topic-b" }],
      },
      bindings: [{ agentId: "topic-a", match: { channel: "telegram", accountId: "default" } }],
    });
    loadConfig.mockImplementation(configForTopicAgent);

    await createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    replySpy.mockImplementation(async () => undefined);

    const sendTopicMessage = async (chatId: number, messageId: number, text: string) => {
      await handler({
        message: {
          chat: { id: chatId, type: "private" },
          from: { id: chatId, username: `user${chatId}` },
          text,
          date: 1736380800 + messageId,
          message_id: messageId,
          message_thread_id: 99,
        },
        me: { username: "openclaw_bot", has_topics_enabled: true },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    };

    await sendTopicMessage(123, 44, "topic one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("agent:topic-a:");
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("thread:123:99");

    topicAgentId = "topic-b";
    await sendTopicMessage(124, 45, "topic two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("agent:topic-b:");
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("thread:124:99");
  });

  it("authorizes and routes channel-DM messages with the canonical topic identity", async () => {
    const chatId = -100123456700;
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      agents: { list: [{ id: "channel-topic-agent" }] },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["701"],
          groups: {
            [String(chatId)]: {
              allowFrom: ["701"],
              requireMention: false,
              topics: {
                "77": {
                  agentId: "channel-topic-agent",
                  allowFrom: ["700"],
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    });

    await dispatchMessage({
      me: { id: 999, username: "openclaw_bot" },
      message: {
        chat: {
          id: chatId,
          type: "supergroup",
          title: "Channel Inbox",
          is_direct_messages: true,
        },
        from: { id: 700, first_name: "Ada" },
        text: "route this topic",
        date: 1736380800,
        message_id: 7700,
        direct_messages_topic: { topic_id: 77 },
        message_thread_id: 999,
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.MessageThreadId).toBe(77);
    expect(payload.OriginatingTo).toBe(`telegram:${chatId}:direct-topic:77`);
    expect(payload.SessionKey).toContain("agent:channel-topic-agent:");
    expect(payload.SessionKey).toContain(":direct-topic:77");
  });

  it.each([
    {
      name: "topic allows and base chat denies",
      baseAllowFrom: ["701"],
      topicAllowFrom: ["700"],
      expectedCalls: 1,
    },
    {
      name: "topic denies and base chat allows",
      baseAllowFrom: ["700"],
      topicAllowFrom: ["701"],
      expectedCalls: 0,
    },
  ])("authorizes channel-DM callbacks from the canonical topic: $name", async (testCase) => {
    const chatId = -100123456701;
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    expect(
      registerPluginInteractiveHandler("channel-topic-actions", {
        channel: "telegram",
        namespace: "channel-topic",
        handler: pluginHandler,
      }),
    ).toEqual({ ok: true });
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: testCase.baseAllowFrom,
          groups: {
            [String(chatId)]: {
              allowFrom: testCase.baseAllowFrom,
              topics: { "77": { allowFrom: testCase.topicAllowFrom } },
            },
          },
        },
      },
    });

    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()({
      callbackQuery: {
        id: `channel-topic-${testCase.expectedCalls}`,
        data: "channel-topic:run",
        from: { id: 700, first_name: "Ada" },
        message: {
          chat: {
            id: chatId,
            type: "supergroup",
            title: "Channel Inbox",
            is_direct_messages: true,
          },
          date: 1736380800,
          message_id: 7701,
          direct_messages_topic: { topic_id: 77 },
          message_thread_id: 999,
        },
      },
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(pluginHandler).toHaveBeenCalledTimes(testCase.expectedCalls);
    clearPluginInteractiveHandlers();
  });

  it.each([
    {
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: {
              "*": { requireMention: false },
              "123": {},
            },
          },
        },
      },
      botRequireMention: true,
      message: {
        chat: { id: 123, type: "group", title: "Dev Chat" },
        text: "hello",
        date: 1736380800,
      },
    },
    {
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      botRequireMention: undefined,
      message: {
        chat: { id: 456, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
      },
    },
    {
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
      },
      botRequireMention: undefined,
      message: {
        chat: { id: 789, type: "group", title: "No Me" },
        text: "hello",
        date: 1736380800,
      },
      me: {},
    },
  ] as const)("applies group mention overrides and fallback behavior %#", async (testCase) => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      ...testCase.config,
      messages: { inbound: { debounceMs: 0 } },
    });
    await dispatchMessage({
      message: { message_id: 1, ...testCase.message },
      me: testCase.me,
      botRequireMention: testCase.botRequireMention,
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  function resetHarnessSpies() {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
  }
  async function createMessageHandler(botRequireMention?: boolean) {
    await createTelegramBot({
      token: "tok",
      ...(typeof botRequireMention === "boolean" ? { requireMention: botRequireMention } : {}),
    });
    return getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  }
  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
    botRequireMention?: boolean;
  }) {
    const handler = await createMessageHandler(params.botRequireMention);
    await handler({
      message: params.message,
      me: params.me ?? { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
  }

  it("blocks group messages for restrictive group config edge cases", async () => {
    const blockedCases = [
      {
        name: "allowlist policy with no groupAllowFrom",
        config: {
          channels: {
            telegram: {
              groupPolicy: "allowlist",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: -100123456789, type: "group", title: "Test Group" },
          from: { id: 123456789, username: "testuser" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        name: "groups map without wildcard",
        config: {
          channels: {
            telegram: {
              groups: {
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 456, type: "group", title: "Ops" },
          text: "@openclaw_bot hello",
          date: 1736380800,
        },
      },
    ] as const;

    for (const testCase of blockedCases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({ message: testCase.message });
      expect(replySpy.mock.calls.length, testCase.name).toBe(0);
    }
  });
  it("blocks group sender not in groupAllowFrom even when sender is paired in DM store", async () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["222222222"],
          groups: { "*": { requireMention: false } },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    await dispatchMessage({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows control commands with TG-prefixed groupAllowFrom entries", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["  TG:123456789  "],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    await dispatchMessage({
      message: {
        message_id: 1,
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "/status",
        date: 1736380800,
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("routes generic-path control commands as text slash when native commands are off", async () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      commands: { text: false, native: false },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 1234, type: "private" },
        from: { id: 42, first_name: "Ada" },
        text: "/compact",
        date: 1736380800,
        message_id: 5,
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.CommandSource).toBe("text");
    expect(payload.CommandTurn).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
    });
  });

  it("retries model callback updates after a bubbled preflight failure", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as BuildModelsProviderDataMock;
    buildModelsProviderDataMock.mockClear();
    editMessageTextSpy.mockClear();

    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const ctx = makeCallbackRetryContext({
      updateId: 666,
      id: "cbq-model-retry-1",
      data: "mdl_prov",
      messageId: 18,
    });

    buildModelsProviderDataMock.mockImplementationOnce(async () => {
      throw new Error("providers boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("providers boom");
    await runMiddlewareChain(ctx);

    expect(buildModelsProviderDataMock).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls.at(0)?.[2]).toContain("Select a provider:");
    expect(
      (
        editMessageTextSpy.mock.calls.at(0)?.[3] as {
          reply_markup?: { inline_keyboard?: unknown[][] };
        }
      )?.reply_markup?.inline_keyboard?.[0]?.[0],
    ).toEqual({
      text: "openai (1)",
      callback_data: "mdl_list_openai_1",
    });
  });

  it("retries command pagination callbacks after a bubbled edit failure", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const ctx = makeCallbackRetryContext({
      updateId: 777,
      id: "cbq-commands-retry-1",
      data: "commands_page_2:main",
      messageId: 19,
    });

    editMessageTextSpy.mockImplementationOnce(async () => {
      throw new Error("edit boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("edit boom");
    await runMiddlewareChain(ctx);

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy.mock.calls.at(-1)?.[2]).toContain("Commands (2/");
  });

  it("treats permanent command pagination edit failures as completed updates", async () => {
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();
    await createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 776,
        onUpdateId,
      },
    });

    const callbackHandler = getOnHandler("callback_query");
    const ctx = makeCallbackRetryContext({
      updateId: 777,
      id: "cbq-commands-permanent-edit-1",
      data: "commands_page_2:main",
      messageId: 20,
    });

    editMessageTextSpy.mockRejectedValueOnce(
      new Error("400: Bad Request: message can't be edited"),
    );

    await expect(
      runTelegramMiddlewareChain({
        ctx,
        finalHandler: callbackHandler,
      }),
    ).resolves.toBeUndefined();

    await flushTelegramTestMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(777);

    await runTelegramMiddlewareChain({
      ctx,
      finalHandler: callbackHandler,
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("does not swallow unprefixed command pagination edit failures", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");

    const ctx = makeCallbackRetryContext({
      updateId: 778,
      id: "cbq-commands-non-telegram-edit-1",
      data: "commands_page_2:main",
      messageId: 21,
    });

    editMessageTextSpy.mockRejectedValueOnce(new Error("message can't be edited"));

    await expect(
      runTelegramMiddlewareChain({
        ctx,
        finalHandler: callbackHandler,
      }),
    ).rejects.toThrow("message can't be edited");

    await runTelegramMiddlewareChain({
      ctx,
      finalHandler: callbackHandler,
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
  });

  it("retries plugin binding approval callbacks after a bubbled resolution failure", async () => {
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const resolvePluginBindingApprovalSpy = vi.mocked(resolvePluginConversationBindingApproval);
    resolvePluginBindingApprovalSpy.mockRejectedValueOnce(new Error("binding boom"));

    const ctx = makeCallbackRetryContext({
      updateId: 888,
      id: "cbq-plugin-binding-retry-1",
      data: buildPluginBindingApprovalCustomId("binding-1", "allow-once"),
      messageId: 20,
      text: "Plugin approval required.",
    });

    try {
      await expect(runMiddlewareChain(ctx)).rejects.toThrow("binding boom");
      await runMiddlewareChain(ctx);
    } finally {
      resolvePluginBindingApprovalSpy.mockRestore();
    }

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls.at(0)?.[1]).toContain("plugin bind approval");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
