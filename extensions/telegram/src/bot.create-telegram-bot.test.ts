import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildPluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import { expectDefined as requireValue } from "openclaw/plugin-sdk/expect-runtime";
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
  telegramBotDepsForTest,
  throttlerSpy,
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

async function createBufferedReplayPair(firstMessageId: number) {
  const handler = getMessageHandler();
  const replay = (messageId: number, text: string) =>
    dispatchSpooledPrivateText(handler, {
      updateId: messageId,
      messageId,
      text,
      date: 1736380800 + messageId,
    });
  const first = await replay(firstMessageId, "first buffered message");
  const second = await replay(firstMessageId + 1, "second buffered message");
  return [
    requireValue(first.deferredWork, "first buffered replay participant"),
    requireValue(second.deferredWork, "second buffered replay participant"),
  ] as const;
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

async function expectBlockedContentExcluded(params: { edited?: boolean; group?: boolean }) {
  loadConfig.mockReturnValue({
    messages: { inbound: { debounceMs: 0 } },
    channels: {
      telegram: params.group
        ? {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
            groups: { "*": { requireMention: false } },
          }
        : { dmPolicy: "allowlist", allowFrom: ["123456789"] },
    },
  });
  const chat = params.group
    ? { id: -100123456789, type: "group", title: "Test Group" }
    : { id: 1234, type: "private" };
  await createTelegramBot({ token: "tok" });
  const blocked = makePrivateTextContext({
    text: "unauthorized secret",
    messageId: 411,
    from: { id: 999999, username: "notallowed" },
    message: { chat, ...(params.edited ? { edit_date: 1736380810 } : {}) },
    downloadable: true,
  });
  if (params.edited) {
    const { message, ...ctx } = blocked;
    await getOnHandler("edited_message")({ ...ctx, editedMessage: message });
  } else {
    await getMessageHandler()(blocked);
  }
  expect(replySpy).not.toHaveBeenCalled();
  await getMessageHandler()(
    makePrivateTextContext({
      text: "authorized follow-up",
      messageId: 412,
      date: 1736380860,
      from: { id: 123456789, username: "allowed" },
      message: { chat },
      downloadable: true,
    }),
  );
  expect(replySpy).toHaveBeenCalledTimes(1);
  expect(replySpy.mock.calls.at(0)?.[0].ChannelStructuredContext).toBeUndefined();
  expect(sendMessageSpy).not.toHaveBeenCalled();
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

  it("acknowledges callbacks before waiting for their chat's active message handler", async () => {
    await createTelegramBot({ token: "tok" });
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const callbackHandler = vi.fn(async () => {});
    const message = runTelegramMiddlewareChain({
      ctx: makePrivateTextContext({ updateId: 1, messageId: 1, chatId: 7, text: "first" }),
      finalHandler: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const runs = [message];

    try {
      await started.promise;
      const callback = runTelegramMiddlewareChain({
        ctx: createTelegramCallbackContext({
          id: "queued-callback",
          data: "ordinary-action",
          updateId: 2,
          message: { chat: { id: 7, type: "private" } },
        }),
        finalHandler: callbackHandler,
      });
      runs.push(callback);
      await runTelegramMiddlewareChain({
        ctx: makePrivateTextContext({ updateId: 3, messageId: 3, chatId: 8, text: "other chat" }),
        finalHandler: async () => {},
      });

      expect(answerCallbackQuerySpy).toHaveBeenCalledExactlyOnceWith("queued-callback");
      expect(callbackHandler).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all(runs);
      expect(callbackHandler).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled(runs);
    }
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

  it("lets /stop@openclaw_bot bypass and cancel pending same-chat inbound debounce", async () => {
    const stopText = "/stop@openclaw_bot";
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "userTimezone" });

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
        message: {
          forward_origin: { type: "hidden_user", date: 1736380700, sender_user_name: "A" },
        },
        replayUpdate: "full",
      });
      const forwardedParticipant = requireValue(
        forwarded.deferredWork,
        "forwarded source participant",
      );
      sourceWork.push(forwardedParticipant.task);
      await vi.advanceTimersByTimeAsync(1_000);
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

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const queuedLifecycleReady = createDeferred<GetReplyOptions["turnAdoptionLifecycle"]>();
    const commitError = new Error("durable dispatch commit failed");
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockRejectedValueOnce(commitError);
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      opts?.turnAdoptionLifecycle?.onDeferred?.();
      queuedLifecycleReady.resolve(opts?.turnAdoptionLifecycle);
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const [firstParticipant, secondParticipant] = await createBufferedReplayPair(221);
      let firstSettled = false;
      let secondSettled = false;
      void firstParticipant.task.then(() => {
        firstSettled = true;
      });
      void secondParticipant.task.then(() => {
        secondSettled = true;
      });

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      const queuedLifecycle = await queuedLifecycleReady.promise;
      expect(queuedLifecycle?.onAdopted).toEqual(expect.any(Function));

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

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const queuedTurnReady = createDeferred<void>();
    const commitStarted = createDeferred<void>();
    const commitGate = createDeferred<void>();
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockImplementationOnce(async () => {
        commitStarted.resolve();
        await commitGate.promise;
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
      queuedTurnReady.resolve();
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const [firstParticipant, secondParticipant] = await createBufferedReplayPair(225);

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await queuedTurnReady.promise;
      expect(runQueuedTurn).toEqual(expect.any(Function));

      const queuedTurn = runQueuedTurn?.();
      await commitStarted.promise;
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

      commitGate.resolve();
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
      commitGate.resolve();
      commitSpy.mockRestore();
      releaseSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("blocks buffered adoption after an exposed replay participant times out", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const queuedLifecycleReady = createDeferred<GetReplyOptions["turnAdoptionLifecycle"]>();
    const commitSpy = vi.spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay");
    let queuedAbortSignal: AbortSignal | undefined;
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedAbortSignal = opts?.abortSignal;
      opts?.turnAdoptionLifecycle?.onDeferred?.();
      queuedLifecycleReady.resolve(opts?.turnAdoptionLifecycle);
      return undefined;
    });

    try {
      await createTelegramBot({ token: "tok" });
      const [firstParticipant, secondParticipant] = await createBufferedReplayPair(223);

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      const queuedLifecycle = await queuedLifecycleReady.promise;
      expect(queuedLifecycle?.onAdopted).toEqual(expect.any(Function));

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

  it.each([false, true])(
    "preserves forwarded origin and formatting across debounce (multiple=%s)",
    async (multiple) => {
      configureOpenDm({ timezone: "envelopeTimezone" });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const sourceWork: Promise<unknown>[] = [];
      let flushForward: (() => void) | undefined;

      try {
        await createTelegramBot({ token: "tok" });
        const messageHandler = getMessageHandler();
        const messages = multiple
          ? ([
              [561, "😀 bold", [{ type: "bold", offset: 3, length: 4 }], "Original A"],
              [
                562,
                "read docs",
                [{ type: "text_link", offset: 5, length: 4, url: "https://docs.example" }],
                "Original B",
              ],
            ] as const)
          : ([[121, "single forwarded note", [], "Original A"]] as const);
        for (const [messageId, text, entities, origin] of messages) {
          const replay = await dispatchSpooledPrivateText(messageHandler, {
            updateId: messageId,
            text,
            messageId,
            date: 1736380800 + messageId,
            replayUpdate: "full",
            message: {
              ...(multiple ? { entities } : {}),
              forward_origin: {
                type: "hidden_user",
                date: 500 + messageId,
                sender_user_name: origin,
              },
            },
          });
          sourceWork.push(requireValue(replay.deferredWork, "forwarded source participant").task);
          flushForward = takeLatestTimerCallback(1_000);
        }

        requireValue(flushForward, "forwarded debounce callback")();
        await Promise.all(sourceWork);
        expect(replySpy).toHaveBeenCalledOnce();
        const payload = requireValue(
          replySpy.mock.calls[0]?.[0],
          "formatted forwarded batch payload",
        );
        if (multiple) {
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
        } else {
          expect(payload.Body).toContain("[Forwarded from Original A");
          expect(payload.ForwardedFrom).toBe("Original A");
        }
      } finally {
        flushForward?.();
        await Promise.allSettled(sourceWork);
        setTimeoutSpy.mockRestore();
      }
    },
  );

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

  it.each([
    {
      name: "opaque payload",
      data: buildTelegramOpaqueCallbackData("code-agent:approve-123 "),
      namespace: "code-agent",
      payload: "approve-123",
      clearButtons: true,
    },
    {
      name: "legacy raw tgcb1 payload",
      data: "tgcb1:inspect:123",
      namespace: "tgcb1",
      payload: "inspect:123",
      clearButtons: false,
    },
  ])(
    "routes $name to its registered plugin without text fallback",
    async ({ data, namespace, payload, clearButtons }) => {
      const pluginHandler = vi.fn(async (ctx) => {
        expect(ctx.callback.namespace).toBe(namespace);
        expect(ctx.callback.payload).toBe(payload);
        if (clearButtons) {
          await ctx.respond.clearButtons();
        }
        return { handled: true };
      });
      expect(
        registerPluginInteractiveHandler("openclaw-code-agent", {
          channel: "telegram",
          namespace,
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
          ...(clearButtons
            ? {
                text: "Approve this code-agent action?",
                message: {
                  reply_markup: {
                    inline_keyboard: [[{ text: "Approve", callback_data: data }]],
                  },
                },
              }
            : {}),
        }),
      );

      expect(pluginHandler).toHaveBeenCalledTimes(1);
      expect(replySpy).not.toHaveBeenCalled();
      if (clearButtons) {
        expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
          reply_markup: { inline_keyboard: [] },
        });
        expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-1");
      } else {
        expect(sendMessageSpy).not.toHaveBeenCalledWith(
          1234,
          "This action is no longer available.",
          undefined,
        );
      }
    },
  );

  it.each([
    { kind: "raw", data: "/fast status" },
    { kind: "native", data: "tgcmd:/fast status" },
    { kind: "opaque", data: buildTelegramOpaqueCallbackData("/codex permissions yolo") },
  ])("respects $kind command callback ownership", async ({ kind, data }) => {
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    if (kind === "native") {
      expect(
        registerPluginInteractiveHandler("namespace-collision", {
          channel: "telegram",
          namespace: "tgcmd",
          handler: pluginHandler,
        }),
      ).toEqual({ ok: true });
    }
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(makeCallbackRetryContext({ id: "cbq-command-1", data, messageId: 10 }));
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-command-1");
    if (kind === "opaque") {
      expect(replySpy).not.toHaveBeenCalled();
    } else {
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
      if (kind === "native") {
        expect(pluginHandler).not.toHaveBeenCalled();
        expect(payload).toMatchObject({ CommandBody: "/fast status", CommandSource: "native" });
      } else {
        expect(payload.Body).toContain("/fast status");
        expect(payload.Body).not.toContain("callback_data: /fast status");
      }
    }
  });

  it.each([
    { error: "400: Bad Request: message can't be edited", retry: false },
    { error: "edit boom", retry: true },
  ])(
    "routes generic callbacks after button cleanup fails with $error",
    async ({ error, retry }) => {
      await createTelegramBot({ token: "tok" });
      const callbackHandler = getOnHandler("callback_query");
      const id = "cbq-generic-clear-1";
      const ctx = makeGenericCallbackContext({ id, ...(retry ? { updateId: 779 } : {}) });
      editMessageReplyMarkupSpy.mockRejectedValueOnce(new Error(error));
      if (retry) {
        await expect(
          runTelegramMiddlewareChain({ ctx, finalHandler: callbackHandler }),
        ).rejects.toThrow(error);
        expect(replySpy).not.toHaveBeenCalled();
        await runTelegramMiddlewareChain({ ctx, finalHandler: callbackHandler });
        expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(2);
      } else {
        await callbackHandler(ctx);
        expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
          reply_markup: { inline_keyboard: [] },
        });
        expect(answerCallbackQuerySpy).toHaveBeenCalledWith(id);
      }
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
      expect(payload.Body).toContain("skip nightly build tonight");
    },
  );

  it("preserves trailing whitespace in OC_MULTI values without routing generic messages", async () => {
    const value = "env|prod ";
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
  });

  it.each([
    {
      id: "cbq-multi-submit-1",
      data: "OC_MULTI|submit",
      buttons: [
        [{ text: "✅ Prod", callback_data: "OC_MULTI|toggle|env|prod" }],
        [{ text: "Blue", callback_data: "OC_MULTI|toggle|blue" }],
      ],
      text: "Multi-select submitted: env|prod",
      clearsButtons: false,
    },
    {
      id: "cbq-select-1",
      data: "OC_SELECT|env|canary",
      buttons: [[{ text: "Canary", callback_data: "OC_SELECT|env|canary" }]],
      text: "Single-select submitted: env|canary",
      clearsButtons: true,
    },
  ])(
    "submits $data as a synthetic inbound message",
    async ({ id, data, buttons, text, clearsButtons }) => {
      await createTelegramBot({ token: "tok" });
      const callbackHandler = getCallbackHandler();
      await callbackHandler(
        makeCallbackRetryContext({
          id,
          data,
          messageId: 10,
          message: { reply_markup: { inline_keyboard: buttons } },
        }),
      );
      if (clearsButtons) {
        expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
          reply_markup: { inline_keyboard: [] },
        });
      }
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].Body).toContain(text);
    },
  );

  it.each([
    { data: "tgcmd:/login codex", namespace: "tgcmd" },
    { data: "tgcb1:invalid", namespace: "missing-plugin" },
  ])(
    "terminalizes $data after inline buttons are disabled without raw-text fallthrough",
    async ({ data, namespace }) => {
      const pluginHandler = vi.fn(async () => ({ handled: true }));
      registerPluginInteractiveHandler("disabled-native-collision", {
        channel: "telegram",
        namespace,
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
    },
  );

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
      agents: { entries: { main: {} } },
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
    expect(sendMessageSpy.mock.calls.at(0)?.[2]).toMatchObject({ parse_mode: "HTML" });
  });

  it.each(["polling", "spooled replay"] as const)(
    "keeps pairing store failures retryable during %s",
    async (mode) => {
      loadConfig.mockReturnValue({
        messages: { inbound: { debounceMs: 0 } },
        channels: { telegram: { dmPolicy: "pairing" } },
      });
      readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
      if (mode === "polling") {
        readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);
      }
      const onUpdateId = vi.fn();

      await createTelegramBot({
        token: "tok",
        ...(mode === "spooled replay" ? { updateOffset: { lastUpdateId: 700, onUpdateId } } : {}),
      });
      const handler = getMessageHandler();
      const sender = { id: 123456789, username: "testuser" };
      const ctx = makePrivateTextContext({
        chatId: 1234,
        text: "hello",
        messageId: mode === "polling" ? 10 : 9,
        from: sender,
        downloadable: true,
      });
      if (mode === "spooled replay") {
        const update = { update_id: 701, message: ctx.message };
        await expect(
          withTelegramSpooledReplayUpdate(update, () =>
            runTelegramMiddlewareChain({ ctx: { ...ctx, update }, finalHandler: handler }),
          ),
        ).rejects.toMatchObject({
          name: TelegramSpooledReplayProcessingError.name,
          cause: expect.objectContaining({ name: "TelegramPairingStoreReadError" }),
        });
        expect(onUpdateId).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
      } else {
        await handler(ctx);
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
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy.mock.calls[0]?.[1]).toMatch(/please try again/i);
        expect(replySpy).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    {
      name: "self-authored updates",
      requireTopic: false,
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
    },
    {
      name: "topic-required root DMs",
      requireTopic: true,
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 413,
        date: 1736380870,
        text: "root dm without topic",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
    },
  ])("drops $name before issuing pairing challenges", async ({ requireTopic, message, me }) => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          ...(requireTopic ? { direct: { "1234": { requireTopic: true } } } : {}),
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    await createTelegramBot({ token: "tok" });
    await getMessageHandler()({
      message,
      me,
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it.each([
    { name: "text DM", edited: false, group: false },
    { name: "edited DM", edited: true, group: false },
    { name: "group-sender edit", edited: true, group: true },
  ])("excludes blocked $name content from authorized prompt context", expectBlockedContentExcluded);

  it.each(["disabled", "pairing"] as const)(
    "blocks unauthorized DM photo downloads with %s policy",
    async (dmPolicy) => {
      loadConfig.mockReturnValue({
        messages: { inbound: { debounceMs: 0 } },
        channels: { telegram: { dmPolicy } },
      });
      if (dmPolicy === "pairing") {
        readChannelAllowFromStore.mockResolvedValue([]);
        upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
      }
      const senderId = dmPolicy === "pairing" ? Number(`${Date.now()}02`.slice(-9)) : 999;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
      );
      const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

      try {
        await createTelegramBot({
          token: "tok",
          ...(dmPolicy === "pairing" ? { testTimings: TELEGRAM_TEST_TIMINGS } : {}),
        });
        const handler = getMessageHandler();

        await handler({
          message: {
            chat: { id: 1234, type: "private" },
            message_id: 412,
            ...(dmPolicy === "pairing" ? { media_group_id: "dm-album-1" } : {}),
            date: 1736380800,
            photo: [{ file_id: "p1" }],
            from: { id: senderId, username: "random" },
          },
          me: { username: "openclaw_bot" },
          getFile: getFileSpy,
        });

        expect(getFileSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        if (dmPolicy === "pairing") {
          expect(sendMessageSpy).toHaveBeenCalledTimes(1);
          const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
          expect(pairingText).toContain("Pairing code:");
          expect(pairingText).toContain("<pre><code>");
          expect(sendMessageSpy.mock.calls.at(0)?.[2]).toMatchObject({ parse_mode: "HTML" });
        } else {
          expect(sendMessageSpy).not.toHaveBeenCalled();
        }
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

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
    const callbackHandler = getCallbackHandler();
    const messageHandler = getMessageHandler();
    const channelPostHandler = getOnHandler("channel_post");

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

    for (let attempt = 0; attempt < 2; attempt++) {
      await messageHandler(
        makePrivateTextContext({
          updateId: 111,
          chatId: 123,
          from: { id: 456, username: "testuser" },
          text: "hello",
          messageId: 42,
          downloadable: true,
        }),
      );
    }
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    for (let attempt = 0; attempt < 2; attempt++) {
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
    }
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

    const replayedCtx = () =>
      makePrivateTextContext({
        updateId: 8488602,
        chatId: 123,
        from: { id: 456, username: "testuser" },
        text: "replay while pending",
        messageId: 43,
        downloadable: true,
      });

    await createTelegramBot({ token: "tok" });
    const firstRun = getMessageHandler()(replayedCtx());
    await firstDispatchStarted.promise;
    expect(replySpy).toHaveBeenCalledTimes(1);

    onSpy.mockClear();
    await createTelegramBot({ token: "tok" });
    await getMessageHandler()(replayedCtx());

    expect(replySpy).toHaveBeenCalledTimes(1);
    finishFirstDispatch.resolve();
    await firstRun;
    await getMessageHandler()(replayedCtx());
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("retries a spooled message after dispatch fails before turn adoption", async () => {
    configureOpenDm();
    const dispatchError = new Error("failed before turn adoption");
    replySpy.mockRejectedValueOnce(dispatchError).mockResolvedValueOnce({ text: "recovered" });

    await createTelegramBot({ token: "tok" });
    const messageHandler = getMessageHandler();
    const replay = () =>
      dispatchSpooledPrivateText(messageHandler, {
        updateId: 8488603,
        chatId: 123,
        from: { id: 456, username: "testuser" },
        text: "retry after pre-adoption failure",
        messageId: 44,
        downloadable: true,
        replayUpdate: "full",
      });
    const firstReplay = await replay();
    const firstDeferredWork = requireValue(firstReplay.deferredWork, "first replay deferred work");
    await expect(firstDeferredWork.task).resolves.toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
    await flushTelegramTestMicrotasks();

    const secondReplay = await replay();
    const secondDeferredWork = requireValue(
      secondReplay.deferredWork,
      "second replay deferred work",
    );
    await expect(secondDeferredWork.task).resolves.toEqual({ kind: "completed" });
    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it.each(["polling", "spooled replay"] as const)(
    "settles recorded dispatch failures during %s",
    async (mode) => {
      const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
        lastUpdateId: 500,
      });
      const update = { update_id: 501 };
      const dispatchError = new Error("dispatch exploded");
      const run = () =>
        runMiddlewareChain({ update }, async () => {
          recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: dispatchError });
        });
      if (mode === "spooled replay") {
        await expect(withTelegramSpooledReplayUpdate(update, run)).rejects.toMatchObject({
          name: TelegramSpooledReplayProcessingError.name,
          cause: dispatchError,
        });
        await flushTelegramTestMicrotasks();
        expect(onUpdateId).not.toHaveBeenCalled();
      } else {
        await run();
        await flushTelegramTestMicrotasks();
        expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501]);
        await runMiddlewareChain({ update: { update_id: 502 } }, async () => {});
        await flushTelegramTestMicrotasks();
        expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501, 502]);
      }
    },
  );

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
        entries: { "topic-a": {}, "topic-b": {} },
      },
      bindings: [{ agentId: "topic-a", match: { channel: "telegram", accountId: "default" } }],
    });
    loadConfig.mockImplementation(configForTopicAgent);

    await createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
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
      agents: { entries: { "channel-topic-agent": {} } },
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

  it("allows group messages when the bot username is unavailable", async () => {
    loadConfig.mockReturnValue({
      messages: { inbound: { debounceMs: 0 } },
      channels: { telegram: { groupPolicy: "open", groups: { "*": { requireMention: true } } } },
    });
    await dispatchMessage({
      message: {
        message_id: 1,
        chat: { id: 789, type: "group", title: "No Me" },
        text: "hello",
        date: 1736380800,
      },
      me: {},
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
  }) {
    await createTelegramBot({ token: "tok" });
    await getMessageHandler()({
      message: params.message,
      me: params.me ?? { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
  }

  it("blocks group messages for restrictive group config edge cases", async () => {
    const blockedCases: {
      name: string;
      config: OpenClawConfig;
      message: Record<string, unknown>;
      storeAllowFrom?: string[];
    }[] = [
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
      {
        name: "DM pairing cannot override the group sender allowlist",
        config: {
          messages: { inbound: { debounceMs: 0 } },
          channels: {
            telegram: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["222222222"],
              groups: { "*": { requireMention: false } },
            },
          },
        },
        storeAllowFrom: ["123456789"],
        message: {
          chat: { id: -100123456789, type: "group", title: "Test Group" },
          from: { id: 123456789, username: "testuser" },
          text: "hello",
          date: 1736380800,
        },
      },
    ];

    for (const testCase of blockedCases) {
      onSpy.mockClear();
      loadConfig.mockReturnValue(testCase.config);
      if (testCase.storeAllowFrom) {
        readChannelAllowFromStore.mockResolvedValueOnce(testCase.storeAllowFrom);
      }
      await dispatchMessage({ message: testCase.message });
      expect(replySpy.mock.calls.length, testCase.name).toBe(0);
    }
  });
  it("routes generic-path control commands as text slash when native commands are off", async () => {
    onSpy.mockClear();
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

  it.each([
    { error: "edit boom", permanent: false },
    { error: "400: Bad Request: message can't be edited", permanent: true },
    { error: "message can't be edited", permanent: false },
  ])("settles or retries command pagination after $error", async ({ error, permanent }) => {
    const onUpdateId = vi.fn();
    await createTelegramBot({
      token: "tok",
      ...(permanent ? { updateOffset: { lastUpdateId: 776, onUpdateId } } : {}),
    });
    const callbackHandler = getOnHandler("callback_query");
    const run = (ctx: TelegramMiddlewareTestContext) =>
      runTelegramMiddlewareChain({ ctx, finalHandler: callbackHandler });
    const ctx = makeCallbackRetryContext({
      updateId: 777,
      id: "cbq-commands-edit-1",
      data: "commands_page_2:main",
      messageId: 20,
    });
    editMessageTextSpy.mockRejectedValueOnce(new Error(error));
    if (permanent) {
      await expect(run(ctx)).resolves.toBeUndefined();
      await flushTelegramTestMicrotasks();
      expect(onUpdateId).toHaveBeenCalledWith(777);
    } else {
      await expect(run(ctx)).rejects.toThrow(error);
    }
    await run(ctx);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(permanent ? 1 : 2);
    if (!permanent) {
      expect(editMessageTextSpy.mock.calls.at(-1)?.[2]).toContain("Commands (2/");
    }
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
