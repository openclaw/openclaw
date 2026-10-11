import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { buildCommandsMessagePaginated } from "openclaw/plugin-sdk/command-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
  registerPluginCommand,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createNonExitingRuntimeEnv,
  mockPublishedModelRuntimeForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  listSessionEntries,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  makeDirectTelegramConfig,
  makeTelegramConfig,
  type TelegramChannelConfig,
} from "./bot.config.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createDirectDispatchContext } from "./bot.direct-dispatch.test-support.js";
import { registerTelegramModelPickerCases } from "./bot.model-picker.test-support.js";
import {
  createReplyPhotoMessage,
  createTelegramCallbackContext,
  makeTelegramKeyedStoreTestMock,
  runTelegramChannelInboundEventWithHarness,
} from "./bot.test-helpers.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "./interactive-dispatch.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";
import { recordTelegramPollRegistryEntry } from "./poll-registry.js";
import {
  setTelegramPluginStateRuntimeForTests,
  setTelegramPollRegistryRuntimeForTests,
} from "./runtime-state.test-support.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";

const questionGatewayHoisted = vi.hoisted(() => ({
  resolveQuestionOverGatewaySpy: vi.fn(async () => ({
    status: "answered" as const,
    questionId: "target",
    optionValue: "Production",
  })),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    resolveOption: questionGatewayHoisted.resolveQuestionOverGatewaySpy,
  },
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const harness = await import("./bot.create-telegram-bot.test-harness.js");
      return await runTelegramChannelInboundEventWithHarness(
        actual,
        params,
        harness.dispatchReplyWithBufferedBlockDispatcher,
      );
    },
  };
});

const {
  answerCallbackQuerySpy,
  deleteBusinessMessagesSpy,
  deleteMessageSpy,
  dispatchReplyWithBufferedBlockDispatcher,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getChatSpy,
  getLoadConfigMock,
  getOnHandler,
  prepareSkillCommandsForAgents,
  onSpy,
  getReadChannelAllowFromStoreMock,
  replySpy,
  resolveExecApprovalSpy,
  sendMessageSpy,
  telegramBotDepsForTest,
} = await import("./bot.create-telegram-bot.test-harness.js");
const { runWithTelegramSpooledReplayUpdate, runWithTelegramUpdateProcessingFrame } =
  await import("./bot-processing-outcome.js");

let createTelegramBotBase: typeof import("./bot-core.js").createTelegramBotCore;
let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
const INFO_EMOJI = "\u{2139}\u{FE0F}";

function mockTelegramConfig(
  telegram: TelegramChannelConfig,
  config: Omit<OpenClawConfig, "channels"> = {},
) {
  loadConfig.mockReturnValue(makeTelegramConfig(telegram, config));
}

type TelegramCallbackQueryOverrides = {
  id: string;
  data: string;
  from?: Record<string, unknown>;
  message?: Record<string, unknown>;
};

type TelegramApprovalResolution = Awaited<ReturnType<typeof resolveExecApprovalSpy>>;

function approvalResolution(
  id: string,
  applied: boolean,
  outcome: { status: "allowed"; decision: "allow-once" } | { status: "denied"; decision: "deny" },
  commandText: string,
  includePreview = true,
): TelegramApprovalResolution {
  return {
    applied,
    approval: {
      id,
      urlPath: `/approve/${encodeURIComponent(id)}`,
      createdAtMs: 1,
      expiresAtMs: 60_000,
      resolvedAtMs: 2,
      reason: "user",
      ...outcome,
      presentation: {
        kind: "exec",
        commandText,
        ...(includePreview ? { commandPreview: commandText } : {}),
        allowedDecisions: ["allow-once", "deny"],
      },
    },
  };
}

function makeCallbackQuery(overrides: TelegramCallbackQueryOverrides) {
  return {
    id: overrides.id,
    data: overrides.data,
    from: overrides.from ?? { id: 9, first_name: "Ada", username: "ada_bot" },
    message: {
      chat: { id: 1234, type: "private" },
      date: 1_736_380_800,
      message_id: 10,
      ...overrides.message,
    },
  };
}

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 10_000;

type TelegramPollRegistryEntry = Omit<
  Parameters<typeof recordTelegramPollRegistryEntry>[0],
  "accountId" | "env"
>;

function makeTelegramPollRegistryEntry(
  overrides: Pick<TelegramPollRegistryEntry, "messageId" | "pollId"> &
    Partial<Omit<TelegramPollRegistryEntry, "messageId" | "pollId">>,
): TelegramPollRegistryEntry {
  return {
    chat: { id: 9876, type: "private", first_name: "Ada" },
    threadSpec: { scope: "dm" },
    question: "Ready?",
    options: ["Yes", "No"],
    ...overrides,
  };
}

async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

function createSignal() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected Telegram bot signal resolver to be initialized");
  }
  return { promise, resolve };
}

function waitForReplyCalls(count: number) {
  const done = createSignal();
  let seen = 0;
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    seen += 1;
    if (seen >= count) {
      done.resolve();
    }
    return undefined;
  });
  return done.promise;
}

function getTelegramCallbackHandlerForTests() {
  return getOnHandler("callback_query") as (ctx: Record<string, unknown>) => Promise<void>;
}

async function createTelegramPluginCallbackHandler(params: {
  handler: TelegramInteractiveHandlerRegistration["handler"];
  namespace?: string;
  pluginId?: string;
  pluginRoot?: string;
  config?: NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
}) {
  registerPluginInteractiveHandler(
    params.pluginId ?? "codex-plugin",
    {
      channel: "telegram",
      namespace: params.namespace ?? "codexapp",
      handler: params.handler as never,
    },
    params.pluginRoot ? { pluginRoot: params.pluginRoot } : undefined,
  );
  await createTelegramBot({
    token: "tok",
    config: params.config ?? {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    },
  });
  return getTelegramCallbackHandlerForTests();
}

function makeExecApprovalTelegramConfig(
  overrides: TelegramChannelConfig = {},
): TelegramChannelConfig {
  return {
    dmPolicy: "open",
    allowFrom: ["*"],
    execApprovals: { enabled: true, approvers: ["9"], target: "dm" },
    ...overrides,
  };
}

function makeModelPickerConfig(
  storePath: string,
  overrides: {
    config?: Omit<OpenClawConfig, "agents" | "channels" | "session">;
    defaultModel?: string;
    models?: Record<string, { agentRuntime?: { id: string } }>;
    omitModels?: boolean;
    telegram?: TelegramChannelConfig;
  } = {},
): OpenClawConfig {
  return {
    ...overrides.config,
    agents: {
      defaults: {
        model: overrides.defaultModel ?? "anthropic/claude-opus-4-6",
        ...(overrides.omitModels
          ? {}
          : {
              models: overrides.models ?? {
                "anthropic/claude-opus-4-6": {},
                "openai/gpt-5.4": {},
              },
            }),
      },
    },
    channels: {
      telegram: overrides.telegram ?? { dmPolicy: "open", allowFrom: ["*"] },
    },
    session: { store: storePath },
  };
}

type DirectTelegramMessageOverrides = Record<string, unknown> & {
  chat?: Record<string, unknown>;
  from?: Record<string, unknown>;
};

function makeDirectTelegramMessageContext(params: {
  chatId: number;
  messageId: number;
  omitText?: boolean;
  senderId?: number;
  message?: DirectTelegramMessageOverrides;
  context?: Record<string, unknown>;
}) {
  const { chat: chatOverrides, from: fromOverrides, ...messageOverrides } = params.message ?? {};
  const chat = { id: params.chatId, type: "private", ...chatOverrides };
  const from = {
    id: params.senderId ?? 202,
    is_bot: false,
    first_name: "Kesava",
    ...fromOverrides,
  };
  return {
    me: { id: 999, username: "openclaw_bot" },
    getFile: getEmptyTelegramFile,
    ...params.context,
    message: {
      chat,
      ...(params.omitText ? {} : { text: "continue" }),
      date: 1_778_474_850,
      message_id: params.messageId,
      from,
      ...messageOverrides,
    },
  };
}

function makeTelegramTransport(fetch: typeof globalThis.fetch) {
  return {
    fetch,
    sourceFetch: fetch,
    close: async () => {},
  };
}

function pngResponse() {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

async function createMessageHandler(
  options: Omit<Parameters<typeof createTelegramBot>[0], "token"> = {},
) {
  await createTelegramBot({ token: "tok", ...options });
  return getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
}

async function createCallbackHandler(
  options: Omit<Parameters<typeof createTelegramBot>[0], "token"> = {},
) {
  await createTelegramBot({ token: "tok", ...options });
  return getTelegramCallbackHandlerForTests();
}

const getEmptyTelegramFile = async () => ({
  download: async () => new Uint8Array(),
});

let telegramTestStoreSequence = 0;

function createTelegramTestStorePath(label: string): string {
  telegramTestStoreSequence += 1;
  return telegramTestState.path(`${label}-${telegramTestStoreSequence}.json`);
}

async function installTelegramPollRegistryForTests(entry?: TelegramPollRegistryEntry) {
  setTelegramPluginStateRuntimeForTests();
  const store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
    namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
    maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  await store.clear();
  if (entry) {
    await recordTelegramPollRegistryEntry(entry);
  }
  return store;
}

function getTelegramPollAnswerHandlerForTests() {
  return getOnHandler("poll_answer") as (ctx: Record<string, unknown>) => Promise<void>;
}

function getTelegramPollHandlerForTests() {
  return getOnHandler("poll") as (ctx: Record<string, unknown>) => Promise<void>;
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call[argIndex];
}

function firstEditMessageTextArg(argIndex: number) {
  return mockArg(editMessageTextSpy, 0, argIndex, "edit message text");
}

function mockMsgContextArg(
  source: MockCallSource,
  callIndex: number,
  argIndex: number,
  label: string,
): MsgContext {
  return mockArg(source, callIndex, argIndex, label) as MsgContext;
}

function readOnlySessionEntry(storePath: string) {
  return listSessionEntries({ storePath })[0]?.entry;
}

async function writeDirectTelegramTranscriptContext(params: {
  cfg: OpenClawConfig;
  storePath: string;
  chatId: number;
  role?: "assistant" | "user";
  senderId: number;
  sessionId: string;
  text: string;
  timestamp: number;
}) {
  const role = params.role ?? "user";
  const { route } = await resolveTelegramConversationRoute({
    cfg: params.cfg,
    accountId: "default",
    chatId: params.chatId,
    isGroup: false,
    threadSpec: { scope: "none" },
    senderId: params.senderId,
  });
  const sessionKey = resolveTelegramConversationBaseSessionKey({
    cfg: params.cfg,
    route,
    chatId: params.chatId,
    isGroup: false,
    senderId: params.senderId,
  });
  await upsertSessionEntry({
    storePath: params.storePath,
    sessionKey,
    entry: {
      sessionId: params.sessionId,
      chatType: "direct",
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      updatedAt: 1,
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId: "main",
    storePath: params.storePath,
    sessionId: params.sessionId,
    sessionKey,
    message: {
      role,
      content: params.text,
      timestamp: params.timestamp,
    },
    eventId: role === "assistant" ? "transcript-assistant-1" : "transcript-user-1",
  });
}

function latestConversationContextMessages(): Record<string, unknown>[] {
  const payload = mockMsgContextArg(replySpy, replySpy.mock.calls.length - 1, 0, "replySpy call");
  const [conversationContext] = requireArray(
    payload.ChannelStructuredContext,
    "structured context",
  );
  const contextPayload = requireRecord(
    requireRecord(conversationContext, "conversation context").payload,
    "conversation context payload",
  );
  return requireArray(contextPayload.messages, "conversation context messages").map(
    (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
  );
}

function execApprovalCall(index = 0) {
  return requireRecord(
    mockArg(resolveExecApprovalSpy, index, 0, "exec approval call"),
    "exec approval call",
  );
}

function execApprovalTelegramConfig(call = execApprovalCall()) {
  return requireRecord(
    requireRecord(requireRecord(call.cfg, "approval cfg").channels, "approval channels").telegram,
    "telegram config",
  );
}

function execApprovalTargetConfig(call = execApprovalCall()) {
  return requireRecord(
    requireRecord(requireRecord(call.cfg, "approval cfg").approvals, "approvals").exec,
    "exec approvals target config",
  );
}

type TelegramDispatch = typeof import("./bot-message-dispatch.js").dispatchTelegramMessage;
type TelegramDispatchParams = Parameters<TelegramDispatch>[0];

async function dispatchDirectTelegramTurn(params: {
  cfg?: OpenClawConfig;
  deliverReplies: NonNullable<TelegramBotDeps["deliverReplies"]>;
  telegramCfg?: TelegramDispatchParams["telegramCfg"];
}) {
  const cfg = params.cfg ?? {};
  const { dispatchTelegramMessage } = await import("./bot-message-dispatch.js");
  const { Bot } = await import("./bot.runtime.js");
  const bot = new Bot("tok", { botInfo: telegramBotInfoForTest });
  return await dispatchTelegramMessage({
    context: createDirectDispatchContext(cfg),
    bot,
    cfg,
    runtime: createNonExitingRuntimeEnv(),
    replyToMode: "first",
    streamMode: "off",
    textLimit: 4096,
    telegramCfg: params.telegramCfg ?? {},
    telegramDeps: {
      ...telegramBotDepsForTest,
      deliverReplies: params.deliverReplies,
      deliverStructuredReplies: params.deliverReplies,
    },
    opts: { token: "tok" },
  });
}

function requireFinalization(result: unknown): Promise<unknown> {
  const record = requireRecord(result, "buffered Telegram delivery result");
  if (!(record.finalization instanceof Promise)) {
    throw new Error("Expected buffered Telegram finalization promise");
  }
  return record.finalization;
}

describe("dispatchTelegramMessage reply settlement", () => {
  it("reports each payload independently when a later provider-hook send is cancelled", async () => {
    const deliverReplies = vi
      .fn<NonNullable<TelegramBotDeps["deliverReplies"]>>()
      .mockResolvedValueOnce({ delivered: true })
      .mockResolvedValueOnce({ delivered: false });
    const results: unknown[] = [];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const deliver = dispatcherOptions.deliver;
      if (!deliver) {
        throw new Error("Expected Telegram reply deliverer");
      }
      results.push(await deliver({ text: "visible first" }, { kind: "final" }));
      results.push(await deliver({ text: "cancelled second" }, { kind: "final" }));
      return { queuedFinal: true, counts: { block: 0, final: 2, tool: 0 } };
    });

    await dispatchDirectTelegramTurn({ deliverReplies });

    expect(results).toEqual([
      { visibleReplySent: true },
      { visibleReplySent: false, suppression: { reason: "no_visible_result" } },
    ]);
    expect(deliverReplies).toHaveBeenCalledTimes(2);
  });

  it("settles a buffered final before a later empty final resets reasoning state", async () => {
    const cfg: OpenClawConfig = { agents: { defaults: { reasoningDefault: "on" } } };
    const deliverReplies = vi
      .fn<NonNullable<TelegramBotDeps["deliverReplies"]>>()
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: true });
    let bufferedFinalization: Promise<unknown> | undefined;
    let emptyFinalResult: unknown;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const deliver = dispatcherOptions.deliver;
      if (!deliver) {
        throw new Error("Expected Telegram reply deliverer");
      }
      await deliver({ text: "<think>first attempt</think>", isReasoning: true }, { kind: "block" });
      bufferedFinalization = requireFinalization(
        await deliver({ text: "buffered answer" }, { kind: "final" }),
      );
      emptyFinalResult = await deliver({}, { kind: "final" });
      return { queuedFinal: true, counts: { block: 1, final: 2, tool: 0 } };
    });

    await dispatchDirectTelegramTurn({ cfg, deliverReplies });

    expect(emptyFinalResult).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    await expect(bufferedFinalization).resolves.toEqual({ visibleReplySent: true });
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({ replies: [expect.objectContaining({ text: "buffered answer" })] }),
    );
  });

  it("keeps buffered-final failure separate from a visible reasoning payload", async () => {
    const cfg: OpenClawConfig = { agents: { defaults: { reasoningDefault: "on" } } };
    const error = new Error("buffered final failed");
    const deliverReplies = vi
      .fn<NonNullable<TelegramBotDeps["deliverReplies"]>>()
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: true })
      .mockRejectedValueOnce(error);
    let bufferedSettlement: Promise<unknown> | undefined;
    let visibleReasoningError: unknown;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const deliver = dispatcherOptions.deliver;
      if (!deliver) {
        throw new Error("Expected Telegram reply deliverer");
      }
      await deliver({ text: "<think>first attempt</think>", isReasoning: true }, { kind: "block" });
      const finalization = requireFinalization(
        await deliver({ text: "buffered answer" }, { kind: "final" }),
      );
      bufferedSettlement = finalization.then(
        () => ({ status: "resolved" as const }),
        (settlementError: unknown) => ({ status: "rejected" as const, error: settlementError }),
      );
      try {
        await deliver(
          { text: "<think>visible reasoning</think>", isReasoning: true },
          { kind: "block" },
        );
      } catch (deliveryError) {
        visibleReasoningError = deliveryError;
      }
      return { queuedFinal: true, counts: { block: 2, final: 1, tool: 0 } };
    });

    await dispatchDirectTelegramTurn({ cfg, deliverReplies });

    expect(visibleReasoningError).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { visibleReplySent: true },
    });
    await expect(bufferedSettlement).resolves.toEqual({ status: "rejected", error });
  });

  it("keeps a suppressed exec-approval final in the fallback ledger", async () => {
    const telegramCfg = {
      execApprovals: { enabled: true, approvers: ["123"], target: "dm" as const },
    };
    const cfg: OpenClawConfig = { channels: { telegram: telegramCfg } };
    const deliverReplies = vi
      .fn<NonNullable<TelegramBotDeps["deliverReplies"]>>()
      .mockResolvedValue({ delivered: true });
    let suppressedResult: unknown;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const deliver = dispatcherOptions.deliver;
      if (!deliver) {
        throw new Error("Expected Telegram reply deliverer");
      }
      suppressedResult = await deliver(
        {
          channelData: {
            execApproval: { approvalId: "req-1", approvalSlug: "req-1" },
          },
        },
        { kind: "final" },
      );
      return {
        queuedFinal: false,
        noVisibleReplyFallbackEligible: true,
        counts: { block: 0, final: 1, tool: 0 },
      };
    });

    await dispatchDirectTelegramTurn({ cfg, deliverReplies, telegramCfg });

    expect(suppressedResult).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });
});

const ORIGINAL_TZ = process.env.TZ;
let telegramTestState: OpenClawTestState;

describe("createTelegramBot", () => {
  beforeAll(async () => {
    ({ createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js"));
  });
  beforeEach(async () => {
    process.env.TZ = "UTC";
    // Isolate persistent state from the operator's real ~/.openclaw: assembled
    // turns resolve session/agent bindings through the state DB, and an ambient
    // Codex session binding fails its generation reclaim, so the embedded agent
    // drops the turn without replying and reply-wait tests hang to timeout.
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    telegramTestState = await createOpenClawTestState({
      label: "telegram-bot",
      layout: "state-only",
    });
  });
  afterEach(async () => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await telegramTestState.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPluginInteractiveHandlers();
    mockTelegramConfig(
      { dmPolicy: "open", allowFrom: ["*"] },
      {
        agents: {
          defaults: {
            userTimezone: "UTC",
          },
        },
      },
    );
    createTelegramBot = (opts) => {
      const telegramDeps = {
        ...telegramBotDepsForTest,
      };
      return createTelegramBotBase({
        botInfo: telegramBotInfoForTest,
        ...opts,
        telegramDeps,
      });
    };
  });

  describe("poll answers", () => {
    afterEach(() => {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
    });

    it.each([
      {
        name: "forum topic",
        entry: makeTelegramPollRegistryEntry({
          pollId: "poll-topic-agent",
          chat: { id: -1001234567890, type: "supergroup", title: "Reviewers" },
          messageId: 321,
          threadSpec: { scope: "forum", id: 99 },
          question: "Escalate?",
        }),
        config: makeTelegramConfig({
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              topics: { "99": { agentId: "forum-agent", requireMention: false } },
            },
          },
        }),
        updateId: 9001,
        senderId: 9,
        botInfo: { id: 999, username: "openclaw_bot" },
        sessionKey: "agent:forum-agent:telegram:group:-1001234567890:topic:99",
      },
      {
        name: "direct-message topic",
        entry: makeTelegramPollRegistryEntry({
          pollId: "poll-dm-topic",
          messageId: 323,
          threadSpec: { scope: "dm", id: 42 },
        }),
        config: undefined,
        updateId: 9002,
        senderId: 9876,
        botInfo: { id: 999, username: "openclaw_bot", has_topics_enabled: false },
        sessionKey: "agent:main:main:thread:9876:42",
      },
    ])(
      "routes poll answers through the recorded $name",
      async ({ entry, config, updateId, senderId, botInfo, sessionKey }) => {
        if (config) {
          getChatSpy.mockResolvedValue({ status: "member" });
          loadConfig.mockReturnValue(config);
        }
        await installTelegramPollRegistryForTests(entry);
        await createTelegramBot({ token: "tok" });
        await getTelegramPollAnswerHandlerForTests()({
          update: { update_id: updateId },
          me: botInfo,
          getFile: getEmptyTelegramFile,
          pollAnswer: {
            poll_id: entry.pollId,
            option_ids: [0],
            user: { id: senderId, first_name: "Ada", username: "ada" },
          },
        });
        expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
        const context = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].ctx;
        if (config) {
          expect(context?.SessionKey).toContain(sessionKey);
          expect(context?.Body).toContain('Poll response to "Escalate?": Yes');
          expect(getChatSpy).toHaveBeenCalledWith(-1001234567890, 9);
        } else {
          expect(context?.SessionKey).toBe(sessionKey);
        }
      },
    );

    it.each([
      {
        name: "forwarded group answer from an allowlisted former member",
        entry: makeTelegramPollRegistryEntry({
          pollId: "poll-forwarded-group",
          chat: { id: -1001234567890, type: "supergroup", title: "Reviewers", is_forum: true },
          messageId: 324,
          threadSpec: { scope: "forum", id: 99 },
          question: "Escalate?",
        }),
        config: makeTelegramConfig({ groupPolicy: "allowlist", groupAllowFrom: ["10"] }),
        updateId: 9003,
        pollAnswer: {
          poll_id: "poll-forwarded-group",
          option_ids: [0],
          user: { id: 10, first_name: "Mallory" },
        },
        checkMembership: true,
      },
      {
        name: "forwarded DM answer from another user",
        entry: makeTelegramPollRegistryEntry({ pollId: "poll-forwarded-dm", messageId: 325 }),
        config: makeTelegramConfig({ dmPolicy: "open", allowFrom: ["*"] }),
        updateId: 9004,
        pollAnswer: {
          poll_id: "poll-forwarded-dm",
          option_ids: [0],
          user: { id: 10, first_name: "Mallory" },
        },
      },
      {
        name: "DM answer missing its required topic",
        entry: makeTelegramPollRegistryEntry({ pollId: "poll-dm-topic", messageId: 322 }),
        config: makeTelegramConfig({
          dmPolicy: "allowlist",
          allowFrom: ["9876"],
          direct: { "9876": { requireTopic: true } },
        }),
        pollAnswer: {
          poll_id: "poll-dm-topic",
          option_ids: [0],
          user: { id: 9876, first_name: "Ada", username: "ada" },
        },
        expectNoChat: true,
      },
      {
        name: "unknown poll id",
        pollAnswer: {
          poll_id: "missing-poll",
          option_ids: [0],
          user: { id: 9, first_name: "Ada" },
        },
      },
      {
        name: "bot voter before registry I/O",
        pollAnswer: {
          poll_id: "poll-skip",
          option_ids: [0],
          user: { id: 9, first_name: "Bot", is_bot: true },
        },
        expectNoLookup: true,
      },
    ])(
      "drops $name",
      async ({
        entry,
        config,
        updateId,
        pollAnswer,
        checkMembership,
        expectNoChat,
        expectNoLookup,
      }) => {
        const lookup = vi.fn(async () => {
          throw new Error("registry should not be read");
        });
        if (expectNoLookup) {
          setTelegramPollRegistryRuntimeForTests(
            makeTelegramKeyedStoreTestMock<TelegramPollRegistryEntry>({ lookup }),
          );
        } else {
          await installTelegramPollRegistryForTests(entry);
        }
        if (config) {
          loadConfig.mockReturnValue(config);
        }
        if (checkMembership) {
          getChatSpy.mockResolvedValueOnce({ status: "left" });
        }
        await createTelegramBot({ token: "tok" });
        await getTelegramPollAnswerHandlerForTests()({
          ...(updateId === undefined ? {} : { update: { update_id: updateId } }),
          pollAnswer,
        });
        expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
        if (checkMembership) {
          expect(getChatSpy).toHaveBeenCalledWith(-1001234567890, 10);
        }
        if (expectNoChat) {
          expect(getChatSpy).not.toHaveBeenCalled();
        }
        if (expectNoLookup) {
          expect(lookup).not.toHaveBeenCalled();
        }
      },
    );

    it("preserves durable replay for synthetic poll-answer turns", async () => {
      await installTelegramPollRegistryForTests(
        makeTelegramPollRegistryEntry({ pollId: "poll-durable-replay", messageId: 326 }),
      );

      await createTelegramBot({ token: "tok" });
      const update = {
        update_id: 9005,
        poll_answer: {
          poll_id: "poll-durable-replay",
          option_ids: [0],
          user: { id: 9876, first_name: "Ada", username: "ada" },
        },
      };

      const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
        await getTelegramPollAnswerHandlerForTests()({
          update,
          me: { id: 999, username: "openclaw_bot" },
          getFile: getEmptyTelegramFile,
          pollAnswer: update.poll_answer,
        });
      });

      expect(replay.deferredWork).toBeDefined();
      await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
      expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    });

    it("retires a closed poll route after the durable replay grace", async () => {
      const entry = makeTelegramPollRegistryEntry({
        pollId: "poll-closed",
        chat: { id: 123, type: "private", first_name: "Ada" },
        messageId: 44,
      });
      const register = vi.fn(async () => {});
      setTelegramPollRegistryRuntimeForTests(
        makeTelegramKeyedStoreTestMock<TelegramPollRegistryEntry>({
          lookup: async () => entry,
          register,
        }),
      );

      await createTelegramBot({ token: "tok" });
      const poll = { id: "poll-closed", is_closed: true };
      await getTelegramPollHandlerForTests()({
        update: { update_id: 9003, poll },
        poll,
      });

      expect(register).toHaveBeenCalledWith("default:poll-closed", entry, {
        ttlMs: 48 * 60 * 60 * 1_000,
      });
    });

    it("marks spooled registry read failures retryable", async () => {
      const readError = new Error("registry db unavailable");
      setTelegramPollRegistryRuntimeForTests(
        makeTelegramKeyedStoreTestMock<TelegramPollRegistryEntry>({
          lookup: async () => {
            throw readError;
          },
        }),
      );

      await createTelegramBot({ token: "tok" });
      const update = {
        update_id: 98082,
        poll_answer: {
          poll_id: "poll-read-error",
          option_ids: [0],
          user: { id: 9, first_name: "Ada" },
        },
      };
      const { result } = await runWithTelegramUpdateProcessingFrame(() =>
        withTelegramSpooledReplayUpdate(update, () =>
          getTelegramPollAnswerHandlerForTests()({
            update,
            pollAnswer: update.poll_answer,
          }),
        ),
      );

      expect(result).toEqual({ kind: "failed-retryable", error: readError });
      expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "uses the live callback allowlist",
      telegram: {
        dmPolicy: "pairing",
        capabilities: { inlineButtons: "allowlist" },
        allowFrom: [],
      },
      startupTelegram: {
        dmPolicy: "pairing",
        capabilities: { inlineButtons: "allowlist" },
        allowFrom: ["9"],
      },
      callback: { id: "cbq-2", data: "cmd:option_b", message: { message_id: 11 } },
      expectedConfigReads: 1,
    },
    {
      name: "blocks unpaired DM model selections",
      telegram: { dmPolicy: "pairing", capabilities: { inlineButtons: "dm" } },
      modelStore: "callback-authz",
      emptyPairingStore: true,
      callback: {
        id: "cbq-model-authz-bypass-1",
        data: "mdl_sel_openai/gpt-5.4",
        from: { id: 999, first_name: "Mallory", username: "mallory" },
        message: { message_id: 19 },
      },
    },
    {
      name: "recomputes group model authorization from runtime commands",
      telegram: {
        dmPolicy: "open",
        capabilities: { inlineButtons: "group" },
        groupPolicy: "open",
        groups: { "*": { requireMention: false } },
      },
      config: { commands: { allowFrom: { telegram: ["9"] } } },
      startupCommands: { allowFrom: { telegram: ["999"] } },
      modelStore: "group-model-authz-runtime",
      refreshAfterStartup: true,
      callback: {
        id: "cbq-group-model-authz-runtime-1",
        data: "mdl_sel_openai/gpt-5.4",
        from: { id: 999, first_name: "Mallory", username: "mallory" },
        message: { chat: { id: -100999, type: "supergroup", title: "Test Group" }, message_id: 22 },
      },
    },
    {
      name: "keeps group questions on the callback allowlist",
      telegram: {
        dmPolicy: "open",
        allowFrom: ["9"],
        capabilities: { inlineButtons: "all" },
        groupPolicy: "open",
        groups: { "*": { requireMention: false, allowFrom: ["9"] } },
      },
      callback: {
        id: "cbq-question-blocked",
        data: "tgq1:ask_0123456789abcdef0123456789abcdef:1",
        from: { id: 999, first_name: "Mallory", username: "mallory" },
        message: { chat: { id: -100999, type: "supergroup", title: "Test Group" }, message_id: 21 },
      },
    },
    {
      name: "blocks approval clicks from non-approvers",
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        execApprovals: { enabled: true, approvers: ["999"], target: "dm" },
      },
      callback: {
        id: "cbq-approve-blocked",
        data: "/approve 138e9b8c allow-once",
        message: { message_id: 22, text: "Run: /approve 138e9b8c allow-once" },
      },
    },
  ] satisfies Array<{
    name: string;
    telegram: TelegramChannelConfig;
    startupTelegram?: TelegramChannelConfig;
    config?: Omit<OpenClawConfig, "channels">;
    startupCommands?: OpenClawConfig["commands"];
    modelStore?: string;
    emptyPairingStore?: boolean;
    refreshAfterStartup?: boolean;
    expectedConfigReads?: number;
    callback: TelegramCallbackQueryOverrides;
  }>)(
    "$name",
    async ({
      telegram,
      startupTelegram,
      config: rootConfig,
      startupCommands,
      modelStore,
      emptyPairingStore,
      refreshAfterStartup,
      expectedConfigReads,
      callback,
    }) => {
      const storePath = modelStore ? createTelegramTestStorePath(modelStore) : undefined;
      const config = storePath
        ? makeModelPickerConfig(storePath, { telegram, config: rootConfig })
        : makeTelegramConfig(telegram, rootConfig);
      const startupConfig = {
        ...config,
        ...(startupTelegram ? { channels: { telegram: startupTelegram } } : {}),
        ...(startupCommands ? { commands: startupCommands } : {}),
      };
      loadConfig.mockReturnValue(refreshAfterStartup ? startupConfig : config);
      if (emptyPairingStore) {
        getReadChannelAllowFromStoreMock().mockResolvedValueOnce([]);
      }
      const callbackHandler = await createCallbackHandler({ config: startupConfig });
      if (refreshAfterStartup) {
        loadConfig.mockReturnValue(config);
      }
      await callbackHandler(createTelegramCallbackContext(callback));
      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
      expect(questionGatewayHoisted.resolveQuestionOverGatewaySpy).not.toHaveBeenCalled();
      expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith(callback.id);
      if (storePath) {
        expect(listSessionEntries({ storePath })).toStrictEqual([]);
      }
      if (expectedConfigReads !== undefined) {
        expect(loadConfig).toHaveBeenCalledTimes(expectedConfigReads);
      }
    },
  );

  it("allows callback_query in groups when group policy authorizes the sender", async () => {
    prepareSkillCommandsForAgents.mockImplementationOnce(async ({ agentIds }) => {
      if (agentIds?.length !== 1 || agentIds[0] !== "main") {
        throw new Error("pagination queried commands for the wrong agent");
      }
      return [];
    });
    await createTelegramBot({
      token: "tok",
      config: makeTelegramConfig({
        dmPolicy: "open",
        capabilities: { inlineButtons: "allowlist" },
        allowFrom: [],
        groupPolicy: "open",
        groups: { "*": { requireMention: false } },
      }),
    });
    const callbackHandler = getTelegramCallbackHandlerForTests();

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-group-1",
        data: "commands_page_2",
        from: { id: 42, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          message_id: 20,
        },
      }),
    );

    expect(prepareSkillCommandsForAgents).toHaveBeenCalledOnce();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      -100999,
      20,
      expect.stringContaining(`${INFO_EMOJI} Commands (2/`),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "◀ Prev", callback_data: "commands_page_1:main" },
              { text: "2/6", callback_data: "commands_page_noop:main" },
              { text: "Next ▶", callback_data: "commands_page_3:main" },
            ],
          ],
        },
      },
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-1");
  });

  it("targets the group member who requests custom question input", async () => {
    const config = makeTelegramConfig({
      dmPolicy: "open",
      allowFrom: ["9"],
      capabilities: { inlineButtons: "all" },
      groupPolicy: "open",
      groups: { "*": { requireMention: false, allowFrom: ["9"] } },
    });
    loadConfig.mockReturnValue(config);
    const callbackHandler = await createCallbackHandler({ config });
    const from = { id: 9, is_bot: false, first_name: "Ada", username: "ada_bot" };

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-question-other",
        data: "tgqo1:ask_0123456789abcdef0123456789abcdef",
        from,
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          message_id: 21,
        },
      }),
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(-100999, "Ada, reply with your own answer.", {
      entities: [{ type: "text_mention", offset: 0, length: 3, user: from }],
      reply_markup: { force_reply: true, selective: true },
    });
  });

  it.each([
    {
      name: "renders canonical truth on a losing typed surface",
      approvalId: "plugin:id-owned-by-exec",
      callbackId: "cbq-typed-approval-loser",
      messageId: 24,
      applied: false,
      outcome: { status: "allowed", decision: "allow-once" },
      commandText: "echo canonical",
      telegram: { capabilities: ["vision"] },
      terminalTitle: "ℹ️ Approval already resolved",
      terminalResult: "Canonical result: Allowed once",
      editFails: false,
    },
    {
      name: "sends a canonical receipt when the clicked message cannot be edited",
      approvalId: "fallback-receipt-id",
      callbackId: "cbq-terminal-edit-fallback",
      messageId: 25,
      applied: true,
      outcome: { status: "denied", decision: "deny" },
      commandText: "echo denied",
      telegram: {},
      terminalTitle: "✅ Approval resolved here",
      terminalResult: "Canonical result: Denied",
      editFails: true,
    },
  ] satisfies Array<{
    name: string;
    approvalId: string;
    callbackId: string;
    messageId: number;
    applied: boolean;
    outcome: { status: "allowed"; decision: "allow-once" } | { status: "denied"; decision: "deny" };
    commandText: string;
    telegram: TelegramChannelConfig;
    terminalTitle: string;
    terminalResult: string;
    editFails: boolean;
  }>)(
    "$name",
    async ({
      approvalId,
      callbackId,
      messageId,
      applied,
      outcome,
      commandText,
      telegram,
      terminalTitle,
      terminalResult,
      editFails,
    }) => {
      if (editFails) {
        editMessageTextSpy.mockRejectedValueOnce(new Error("Bad Request: message can't be edited"));
      }
      resolveExecApprovalSpy.mockResolvedValueOnce(
        approvalResolution(approvalId, applied, outcome, commandText),
      );
      mockTelegramConfig(makeExecApprovalTelegramConfig(telegram));
      const callbackHandler = await createCallbackHandler();
      const callbackData = buildTelegramApprovalCallbackData({
        type: "approval",
        approvalId,
        approvalKind: "exec",
        decision: "deny",
      });
      if (!callbackData) {
        throw new Error("Expected typed approval callback data");
      }
      await callbackHandler(
        createTelegramCallbackContext({
          id: callbackId,
          data: callbackData,
          message: { message_id: messageId, text: "Approval required." },
        }),
      );
      expect(execApprovalCall()).toMatchObject({
        approvalId,
        approvalKind: "exec",
        decision: "deny",
        senderId: "9",
      });
      const terminalText = [
        terminalTitle,
        terminalResult,
        `ID: ${approvalId}`,
        "",
        "Command:",
        commandText,
      ].join("\n");
      expect(editMessageTextSpy).toHaveBeenCalledWith(1234, messageId, terminalText, {
        reply_markup: { inline_keyboard: [] },
      });
      if (editFails) {
        expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, messageId, {
          reply_markup: { inline_keyboard: [] },
        });
        expect(sendMessageSpy).toHaveBeenCalledWith(1234, terminalText, undefined);
      } else {
        expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
      }
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith(callbackId);
    },
  );

  it("consumes malformed callbacks in the reserved approval namespace", async () => {
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    registerPluginInteractiveHandler("reserved-approval-test", {
      channel: "telegram",
      namespace: "tga1",
      handler: pluginHandler as never,
    });

    mockTelegramConfig(makeExecApprovalTelegramConfig());
    await createTelegramBot({ token: "tok" });

    await getTelegramCallbackHandlerForTests()(
      createTelegramCallbackContext({
        id: "cbq-malformed-reserved-approval",
        data: "tga1:e:x:req-1",
        message: {
          message_id: 26,
          text: "Approval required.",
        },
      }),
    );

    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      26,
      "ℹ️ Approval action unavailable\nThis button is invalid or no longer actionable.",
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-malformed-reserved-approval");
  });

  it.each([
    {
      name: "terminalizes stale legacy clicks from canonical records without retrying owners",
      approvalId: "stale-legacy-id",
      callbackId: "cbq-stale-legacy",
      decision: "allow-once",
      messageId: 25,
      firstError: "resolved",
      secondOutcome: "canonical",
      expectedCalls: 2,
      expectedTerminal: "Canonical result: Denied",
      secondOwner: "canonical-exec",
    },
    {
      name: "renders neutral terminal copy when a stale record cannot be fetched",
      approvalId: "stale-neutral-id",
      callbackId: "cbq-stale-legacy-neutral",
      decision: "deny",
      messageId: 26,
      firstError: "resolved",
      secondOutcome: "missing",
      expectedCalls: 2,
      expectedTerminal:
        "It was already resolved or expired; the canonical decision is unavailable here.",
    },
    {
      name: "resolves opaque plugin ids without inferring kind from spelling",
      approvalId: "opaque-plugin-approval-id",
      callbackId: "cbq-plugin-approve",
      decision: "allow-once",
      messageId: 24,
      messageText: "Plugin approval required.",
      firstError: "missing",
      expectedCalls: 2,
      expectedTerminal: "✅ Approval resolved here",
      secondOwner: "plugin",
      checkTelegramConfig: true,
    },
    {
      name: "preserves ambiguous target-only stale callbacks for another approver",
      approvalId: "plugin:misleading-exec-id",
      callbackId: "cbq-legacy-plugin-fallback-blocked",
      decision: "allow-once",
      messageId: 25,
      messageText: "Legacy plugin approval required.",
      targetOnly: true,
      firstError: "missing",
      expectedCalls: 1,
      expectNoChatReply: true,
    },
    {
      name: "renders a no-longer-pending receipt for expired legacy callbacks",
      approvalId: "138e9b8c",
      callbackId: "cbq-expired-approval",
      decision: "allow-once",
      messageId: 26,
      firstError: "missing",
      secondOutcome: "missing",
      expectedCalls: 2,
      expectedTerminal: "ℹ️ Approval no longer pending",
      secondOwner: "plugin",
      expectNoChatReply: true,
    },
  ] satisfies Array<{
    name: string;
    approvalId: string;
    callbackId: string;
    decision: "allow-once" | "deny";
    messageId: number;
    messageText?: string;
    targetOnly?: boolean;
    firstError?: "resolved" | "missing";
    secondOutcome?: "canonical" | "missing";
    expectedCalls: number;
    expectedTerminal?: string;
    secondOwner?: "canonical-exec" | "plugin";
    checkTelegramConfig?: boolean;
    expectNoChatReply?: boolean;
  }>)(
    "$name",
    async ({
      approvalId,
      callbackId,
      decision,
      messageId,
      messageText,
      targetOnly,
      firstError,
      secondOutcome,
      expectedCalls,
      expectedTerminal,
      secondOwner,
      checkTelegramConfig,
      expectNoChatReply,
    }) => {
      if (firstError) {
        resolveExecApprovalSpy.mockRejectedValueOnce(
          firstError === "resolved"
            ? Object.assign(new Error("approval already resolved"), {
                gatewayCode: "INVALID_REQUEST",
                details: { reason: "APPROVAL_ALREADY_RESOLVED" },
              })
            : new Error("unknown or expired approval id"),
        );
      }
      if (secondOutcome === "canonical") {
        resolveExecApprovalSpy.mockResolvedValueOnce(
          approvalResolution(
            approvalId,
            false,
            { status: "denied", decision: "deny" },
            "echo denied",
            false,
          ),
        );
      } else if (secondOutcome === "missing") {
        resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));
      }
      if (targetOnly) {
        mockTelegramConfig(
          { dmPolicy: "open", allowFrom: ["*"] },
          {
            approvals: {
              exec: { enabled: true, mode: "targets", targets: [{ channel: "telegram", to: "9" }] },
            },
          },
        );
      } else {
        mockTelegramConfig(makeExecApprovalTelegramConfig());
      }
      const callbackHandler = await createCallbackHandler();
      await callbackHandler(
        createTelegramCallbackContext({
          id: callbackId,
          data: `/approve ${approvalId} ${decision}`,
          message: { message_id: messageId, text: messageText ?? "Approval required." },
        }),
      );
      const approvalCall = execApprovalCall();
      expect(approvalCall).toMatchObject({
        approvalId,
        resolveMethod: "exec",
        decision,
        senderId: "9",
      });
      if (targetOnly) {
        const execApprovals = execApprovalTargetConfig(approvalCall);
        expect(execApprovals.enabled).toBe(true);
        expect(execApprovals.mode).toBe("targets");
      }
      if (checkTelegramConfig) {
        const execApprovals = requireRecord(
          execApprovalTelegramConfig(approvalCall).execApprovals,
          "telegram exec approvals",
        );
        expect(execApprovals.enabled).toBe(true);
        expect(execApprovals.approvers).toEqual(["9"]);
        expect(execApprovals.target).toBe("dm");
      }
      expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(expectedCalls);
      if (secondOwner) {
        expect(execApprovalCall(1)).toMatchObject({
          approvalId,
          ...(secondOwner === "canonical-exec"
            ? { approvalKind: "exec" }
            : { resolveMethod: "plugin", decision, senderId: "9" }),
        });
      }
      if (expectedTerminal) {
        expect(editMessageTextSpy).toHaveBeenCalledWith(
          1234,
          messageId,
          expect.stringContaining(expectedTerminal),
          { reply_markup: { inline_keyboard: [] } },
        );
      } else {
        expect(editMessageTextSpy).not.toHaveBeenCalled();
      }
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
      if (expectNoChatReply) {
        expect(replySpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
      }
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith(callbackId);
    },
  );

  it.each([
    {
      name: "stale canonical convergence",
      approvalId: "stale-retry-id",
      decision: "deny",
      callbackId: "cbq-stale-legacy-retry",
      messageId: 27,
      errorMessage: "gateway unavailable",
      stale: true,
    },
    {
      name: "legacy resolution without exposing error details",
      approvalId: "138e9b8c",
      decision: "allow-once",
      callbackId: "cbq-approve-error",
      messageId: 25,
      errorMessage: "gateway secret detail",
      stale: false,
    },
  ])(
    "retries failed $name",
    async ({ approvalId, decision, callbackId, messageId, errorMessage, stale }) => {
      if (stale) {
        resolveExecApprovalSpy.mockRejectedValueOnce(
          Object.assign(new Error("approval already resolved"), {
            gatewayCode: "INVALID_REQUEST",
            details: { reason: "APPROVAL_ALREADY_RESOLVED" },
          }),
        );
      }
      resolveExecApprovalSpy.mockRejectedValueOnce(new Error(errorMessage));
      mockTelegramConfig(makeExecApprovalTelegramConfig());
      const callbackHandler = await createCallbackHandler();
      await expect(
        callbackHandler(
          createTelegramCallbackContext({
            id: callbackId,
            data: `/approve ${approvalId} ${decision}`,
            message: { message_id: messageId, text: "Approval required." },
          }),
        ),
      ).rejects.toThrow(errorMessage);
      expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(stale ? 2 : 1);
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith(callbackId);
    },
  );

  it("terminalizes unowned opaque approval-shaped plugin callbacks", async () => {
    mockTelegramConfig(makeExecApprovalTelegramConfig());
    const callbackHandler = await createCallbackHandler();

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-opaque-plugin-approve",
        data: buildTelegramOpaqueCallbackData("/approve plugin:138e9b8c allow-once"),
        message: { message_id: 25, text: "Plugin callback." },
      }),
    );

    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 25, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "This action is no longer available.",
      undefined,
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-opaque-plugin-approve");
  });

  it("keeps hyphenated plugin names as code when command pagination is edited", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      expect(
        registerPluginCommand("memory-fixture", {
          name: "active-memory",
          description: "Inspect memory <scope>",
          handler: async () => ({ text: "memory" }),
        }),
      ).toEqual({ ok: true });
      const config = makeTelegramConfig(
        { dmPolicy: "open", allowFrom: ["*"] },
        { agents: { defaults: { userTimezone: "UTC" } } },
      );
      loadConfig.mockReturnValue(config);
      const callbackHandler = await createCallbackHandler({ config });
      const page = buildCommandsMessagePaginated(config, [], {
        surface: "telegram",
        forcePaginatedList: true,
        page: Number.MAX_SAFE_INTEGER,
      });
      expect(page.text).toContain("active-memory");
      await callbackHandler(
        createTelegramCallbackContext({
          id: "cbq-command-code",
          data: `commands_page_${page.currentPage}:main`,
          message: { message_id: 17 },
        }),
      );
      expect(editMessageTextSpy).toHaveBeenCalledWith(
        1234,
        17,
        expect.stringContaining("<code>/active-memory</code>"),
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain("Inspect memory &lt;scope&gt;");
    });
  });

  it("ignores unsafe command pagination pages", async () => {
    const callbackHandler = await createCallbackHandler();

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-unsafe-page",
        data: "commands_page_9007199254740993:main",
        message: { message_id: 16 },
      }),
    );

    expect(prepareSkillCommandsForAgents).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
  });

  registerTelegramModelPickerCases({
    createTelegramTestStorePath,
    makeModelPickerConfig,
    loadConfig,
    createTelegramBot: async (options) => await createTelegramBot(options),
    getTelegramCallbackHandlerForTests,
    firstEditMessageTextArg,
    harness: { telegramBotDepsForTest, replySpy, editMessageTextSpy, answerCallbackQuerySpy },
  });

  it("keeps hot-reloaded model pins on the next assembled turn", async () => {
    const storePath = createTelegramTestStorePath("model-fresh-cfg");
    const debounceMs = 4321;
    const startupConfig = makeModelPickerConfig(storePath, {
      defaultModel: "openai/gpt-5.4",
      config: { messages: { inbound: { debounceMs } } },
    });

    const freshConfig = {
      ...startupConfig,
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          models: {
            "openai/gpt-5.4": {},
            "openai/gpt-4.1": {},
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
    };
    const authorizationConfig = { ...freshConfig };
    const modelCatalog = [
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      {
        provider: "openai",
        id: "gpt-4.1",
        name: "GPT-4.1",
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
      },
      { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
    ];
    await mockPublishedModelRuntimeForTest({
      config: freshConfig,
      isCurrent: () => true,
      facts: { modelCatalog: { entries: modelCatalog, routeVariants: modelCatalog } },
      paths: {
        agentDir: telegramTestState.agentDir(),
        workspaceDir: telegramTestState.workspaceDir,
      },
      authStore: {
        version: 1,
        profiles: {
          "openai:fixture": { type: "api_key", provider: "openai", key: "synthetic-openai" },
          "anthropic:fixture": {
            type: "api_key",
            provider: "anthropic",
            key: "synthetic-anthropic",
          },
        },
      },
    });
    vi.mocked(telegramBotDepsForTest.buildModelsProviderData).mockResolvedValue({
      byProvider: new Map([
        ["openai", new Set(["gpt-5.4", "gpt-4.1"])],
        ["anthropic", new Set(["claude-opus-4-6"])],
      ]),
      providers: ["anthropic", "openai"],
      resolvedDefault: { provider: "anthropic", model: "claude-opus-4-6" },
      modelNames: new Map(),
      modelCatalog,
    });

    loadConfig.mockReturnValue(freshConfig);
    const callbackHandler = await createCallbackHandler({ config: startupConfig });

    // The old startup default is no longer the live default, so selecting it
    // must persist an override instead of being cleared as inherited.
    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-model-fresh-cfg-1",
        data: "mdl_sel_openai/gpt-5.4",
        message: { message_id: 20 },
      }),
    );

    const entry = readOnlySessionEntry(storePath);
    expect(entry?.providerOverride).toBe("openai");
    expect(entry?.modelOverride).toBe("gpt-5.4");
    expect(entry?.modelOverrideSource).toBe("user");

    // A model added after startup must also resolve and become the new user pin.
    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-model-fresh-cfg-2",
        data: "mdl_sel_openai/gpt-4.1",
        message: { date: 1_736_380_801, message_id: 21 },
      }),
    );

    const addedModelEntry = readOnlySessionEntry(storePath);
    expect(addedModelEntry?.providerOverride).toBe("openai");
    expect(addedModelEntry?.modelOverride).toBe("gpt-4.1");
    expect(addedModelEntry?.modelOverrideSource).toBe("user");

    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    replySpy.mockClear();
    loadConfig.mockClear();
    loadConfig
      .mockImplementationOnce(() => authorizationConfig)
      .mockImplementationOnce(() => freshConfig)
      .mockReturnValue(startupConfig);

    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      await messageHandler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: getEmptyTelegramFile,
        message: {
          chat: { id: 1234, type: "private" },
          text: "use the selected model",
          date: 1_736_380_802,
          message_id: 22,
          from: { id: 9, is_bot: false, first_name: "Ada", username: "ada_bot" },
        },
      });

      expect(loadConfig).toHaveBeenCalledTimes(1);
      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === debounceMs,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();
      await replyDelivered;
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(loadConfig).toHaveBeenCalledTimes(2);
    const dispatchParams = mockArg(
      dispatchReplyWithBufferedBlockDispatcher,
      0,
      0,
      "buffered dispatch",
    ) as { cfg?: OpenClawConfig };
    expect(dispatchParams.cfg).toBe(freshConfig);

    const afterTurn = readOnlySessionEntry(storePath);
    expect(afterTurn?.providerOverride).toBe("openai");
    expect(afterTurn?.modelOverride).toBe("gpt-4.1");
    expect(afterTurn?.modelOverrideSource).toBe("user");
  });

  it("rejects ambiguous compact model callbacks and returns provider list", async () => {
    vi.mocked(telegramBotDepsForTest.buildModelsProviderData).mockResolvedValue({
      byProvider: new Map([
        ["anthropic", new Set(["shared-model"])],
        ["openai", new Set(["shared-model"])],
      ]),
      providers: ["anthropic", "openai"],
      resolvedDefault: { provider: "anthropic", model: "shared-model" },
      modelNames: new Map(),
      modelCatalog: [
        { provider: "anthropic", id: "shared-model", name: "Shared model", reasoning: false },
        { provider: "openai", id: "shared-model", name: "Shared model", reasoning: false },
      ],
    });
    await createTelegramBot({
      token: "tok",
      config: {
        agents: {
          defaults: {
            model: "anthropic/shared-model",
            models: {
              "anthropic/shared-model": {},
              "openai/shared-model": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getTelegramCallbackHandlerForTests();

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-model-compact-2",
        data: "mdl_sel/shared-model",
        message: { message_id: 15 },
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(String(firstEditMessageTextArg(2))).toContain(
      "Available models changed. Open /models and choose again.",
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-2");
  });

  it("honors historyLimit zero for group chat-window context", async () => {
    mockTelegramConfig(
      {
        groupPolicy: "allowlist",
        groupAllowFrom: ["111", "222"],
        historyLimit: 0,
        groups: { "*": { requireMention: true } },
      },
      { agents: { defaults: { userTimezone: "UTC" } } },
    );

    const handler = await createMessageHandler();
    const baseCtx = {
      me: { id: 999, username: "openclaw_bot" },
      getFile: getEmptyTelegramFile,
    };

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "Do not include this cached group line.",
        date: 1736380800,
        message_id: 601,
        from: { id: 111, is_bot: false, first_name: "Requester" },
      },
    });
    expect(replySpy).not.toHaveBeenCalled();

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "@openclaw_bot Hello",
        date: 1736380860,
        message_id: 602,
        from: { id: 222, is_bot: false, first_name: "Operator" },
        entities: [{ type: "mention", offset: 0, length: 13 }],
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy call");
    expect(payload.ChannelStructuredContext).toBeUndefined();
    expect(payload.Body).not.toContain("Do not include this cached group line.");
  });

  it("keeps direct Telegram media context when transcript context exists", async () => {
    const storePath = createTelegramTestStorePath("dm-media-context");
    const config = makeDirectTelegramConfig(storePath);

    loadConfig.mockReturnValue(config);
    const handler = await createMessageHandler({ config });
    await handler(
      makeDirectTelegramMessageContext({
        chatId: 7771,
        messageId: 100,
        omitText: true,
        message: {
          caption: "the reference image",
          date: 1778474800,
          photo: [{ file_id: "reference-photo-1", width: 1, height: 1 }],
        },
      }),
    );

    await writeDirectTelegramTranscriptContext({
      cfg: config,
      storePath,
      chatId: 7771,
      senderId: 202,
      sessionId: "telegram-dm-media-context-session",
      text: "remember the launch checklist",
      timestamp: 1778474700000,
    });

    replySpy.mockClear();
    await handler(
      makeDirectTelegramMessageContext({
        chatId: 7771,
        messageId: 101,
        message: { text: "what about the image above?", date: 1778474850 },
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const messages = latestConversationContextMessages();
    expect(messages.some((message) => message.body === "remember the launch checklist")).toBe(true);
    const photoMessage = messages.find((message) => message.message_id === "100");
    expect(photoMessage?.body).toBe("the reference image");
    expect(photoMessage?.media_ref).toBe("telegram:file/reference-photo-1");
  });

  it.each([
    { spooled: false, text: "continue after polling restart" },
    { spooled: true, text: "keep the old image" },
  ])(
    "settles aborted reply media according to spool ownership: $spooled",
    async ({ spooled, text }) => {
      const owner = new AbortController();
      let replyMediaAborted: boolean | undefined;
      getFileSpy.mockImplementationOnce(async (_fileId, signal) => {
        owner.abort(spooled ? new Error("claim adoption stalled") : undefined);
        replyMediaAborted = signal instanceof AbortSignal ? signal.aborted : undefined;
        throw spooled
          ? new Error("Bad Request: file is too big")
          : Object.assign(new Error("aborted"), { name: "AbortError" });
      });
      const handler = await createMessageHandler(spooled ? {} : { fetchAbortSignal: owner.signal });
      const message = createReplyPhotoMessage(text);
      const update = { update_id: 98081, message };
      const context = {
        ...(spooled ? { update } : {}),
        message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      };
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        if (spooled) {
          await runWithTelegramSpooledReplayUpdate(update, () => handler(context), {
            abortSignal: owner.signal,
            onAdopted: vi.fn(),
            onDeferred: vi.fn(),
            onAdoptionFinalizing: vi.fn(),
            onAbandoned: vi.fn(),
          });
        } else {
          await handler(context);
        }
      });
      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
      if (spooled) {
        expect(replyMediaAborted).toBe(true);
        expect(result).toEqual({ kind: "failed-retryable", error: expect.any(Error) });
        expect(replySpy).not.toHaveBeenCalled();
      } else {
        expect(result?.kind).not.toBe("failed-retryable");
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(mockMsgContextArg(replySpy, 0, 0, "replySpy call").Body).toContain(text);
      }
    },
  );

  it("durably retries when primary media hydration outlives its claim owner", async () => {
    const claimOwner = new AbortController();
    const timeoutError = new Error("claim adoption stalled");
    let mediaAborted: boolean | undefined;
    const mediaFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      claimOwner.abort(timeoutError);
      mediaAborted = init?.signal?.aborted;
      return pngResponse();
    });
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      const handler = await createMessageHandler({
        telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
      });
      const update = {
        update_id: 98083,
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9002,
          caption: "inspect this image",
          date: 1_736_380_800,
          from: { id: 42, first_name: "Ada" },
          photo: [{ file_id: "primary-photo-1" }],
        },
      };

      const { result } = await runWithTelegramUpdateProcessingFrame(() =>
        runWithTelegramSpooledReplayUpdate(
          update,
          () =>
            handler({
              update,
              message: update.message,
              me: { username: "openclaw_bot" },
              getFile: async () => ({ file_path: "media/primary-photo.jpg" }),
            }),
          {
            abortSignal: claimOwner.signal,
            onAdopted: vi.fn(),
            onDeferred: vi.fn(),
            onAdoptionFinalizing: vi.fn(),
            onAbandoned: vi.fn(),
          },
        ),
      );

      expect(mediaAborted).toBe(true);
      expect(result).toEqual({ kind: "failed-retryable", error: timeoutError });
      expect(mediaFetch).toHaveBeenCalledTimes(1);
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      ssrfMock.mockRestore();
    }
  });

  it.each([
    {
      name: "hydrates allowlisted group reply ancestors",
      allowFrom: ["1", "999"],
      expectHydrated: true,
      chatId: 7,
    },
    {
      name: "does not hydrate unallowlisted group reply ancestors through quote override",
      allowFrom: ["1"],
      expectHydrated: false,
      chatId: 8,
    },
  ])("$name", async ({ allowFrom, expectHydrated, chatId }) => {
    mockTelegramConfig({ groupPolicy: "open", contextVisibility: "allowlist_quote", allowFrom });

    const mediaFetch = vi.fn(async () => pngResponse());
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      const handler = await createMessageHandler({
        telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
      });
      const baseCtx = {
        me: { id: 999, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
        getFile: getEmptyTelegramFile,
      };
      const chat = { id: chatId, type: "group", title: "Ops" };

      await handler({
        ...baseCtx,
        message: {
          chat,
          message_id: 102,
          text: "Why is there a 4th person?",
          date: 1736380750,
          from: { id: 2, is_bot: false, first_name: "UserB" },
          reply_to_message: {
            chat,
            message_id: 101,
            text: "Done, here is the image",
            date: 1736380700,
            from: { id: 999, is_bot: true, first_name: "OpenClaw" },
            photo: [
              {
                file_id: "generated-photo-1",
                file_unique_id: "generated-photo-u1",
                width: 1,
                height: 1,
              },
            ],
          },
        },
      });

      expect(getFileSpy).toHaveBeenCalledWith("generated-photo-1", expect.any(AbortSignal));
      expect(mediaFetch).toHaveBeenCalledTimes(1);

      replySpy.mockClear();
      getFileSpy.mockClear();
      mediaFetch.mockClear();

      await handler({
        ...baseCtx,
        message: {
          chat,
          message_id: 103,
          text: "@openclaw_bot explain what went wrong",
          date: 1736380800,
          from: { id: 1, is_bot: false, first_name: "UserA" },
          reply_to_message: {
            chat,
            message_id: 102,
            text: "Why is there a 4th person?",
            date: 1736380750,
            from: { id: 2, is_bot: false, first_name: "UserB" },
          },
        },
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy call") as {
      ReplyChain?: Array<{
        messageId?: string;
        sender?: string;
        body?: string;
        mediaRef?: string;
        mediaPath?: string;
      }>;
      ChannelStructuredContext?: unknown[];
    };
    expect(payload.ReplyChain?.map((entry) => entry.messageId)).toEqual(["102", "101"]);
    expect(payload.ReplyChain?.[1]).toMatchObject({
      sender: "OpenClaw (you)",
      body: "Done, here is the image",
    });
    if (expectHydrated) {
      expect(payload.ReplyChain?.[1]?.mediaPath).toBeTypeOf("string");
      expect(payload.ReplyChain?.[1]?.mediaRef).toBeUndefined();
    } else {
      expect(payload.ReplyChain?.[1]?.mediaPath).toBeUndefined();
      expect(payload.ReplyChain?.[1]?.mediaRef).toBe("telegram:file/generated-photo-1");
    }
    const messages = latestConversationContextMessages();
    const messagesById = new Map(messages.map((message) => [message.message_id, message]));
    expect(messagesById.get("101")).toMatchObject({
      sender: "OpenClaw (you)",
      body: "Done, here is the image",
      is_reply_target: true,
    });
    if (expectHydrated) {
      expect(messagesById.get("101")?.media_path).toMatch(/^media:\/\/inbound\//);
      expect(messagesById.get("101")?.media_ref).toBeUndefined();
    } else {
      expect(messagesById.get("101")?.media_path).toBeUndefined();
      expect(messagesById.get("101")?.media_ref).toBe("telegram:file/generated-photo-1");
    }
    expect(messagesById.get("102")).toMatchObject({
      sender: "UserB",
      body: "Why is there a 4th person?",
      reply_to_id: "101",
      is_reply_target: true,
    });
    expect(getFileSpy).not.toHaveBeenCalled();
    expect(mediaFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "General forum topic",
      chatId: -1007,
      topicId: "1",
      chat: { id: -1007, type: "supergroup", title: "Ops", is_forum: true },
      topicFields: {},
      photoId: "hidden-photo-1",
    },
    {
      name: "refreshed channel-DM topic",
      chatId: -1010,
      topicId: "77",
      chat: {
        id: -1010,
        type: "supergroup",
        title: "Channel Inbox",
        is_direct_messages: true,
      },
      topicFields: { direct_messages_topic: { topic_id: 77 }, message_thread_id: 999 },
      photoId: "hidden-channel-photo-1",
    },
  ])(
    "does not hydrate reply media denied by $name visibility",
    async ({ chatId, topicId, chat, topicFields, photoId }) => {
      mockTelegramConfig({
        groupPolicy: "allowlist",
        contextVisibility: "allowlist",
        groups: {
          [chatId]: {
            requireMention: false,
            allowFrom: ["1", "2"],
            topics: { [topicId]: { allowFrom: ["1"], requireMention: false } },
          },
        },
      });
      const mediaFetch = vi.fn(async () => pngResponse());
      const ssrfMock = mockPinnedHostnameResolution();
      setTelegramPluginStateRuntimeForTests();
      try {
        const replyDelivered = waitForReplyCalls(1);
        const handler = await createMessageHandler({
          telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
        });
        await handler({
          me: { id: 999, username: "openclaw_bot" },
          getFile: getEmptyTelegramFile,
          message: {
            chat,
            ...topicFields,
            message_id: 103,
            text: "explain this",
            date: 1736380800,
            from: { id: 1, is_bot: false, first_name: "Allowed" },
            reply_to_message: {
              chat,
              message_id: 102,
              caption: "hidden image",
              date: 1736380750,
              from: { id: 2, is_bot: false, first_name: "Hidden" },
              photo: [{ file_id: photoId }],
            },
          },
        });
        await replyDelivered;
      } finally {
        ssrfMock.mockRestore();
        clearTelegramRuntime();
        resetPluginStateStoreForTests();
      }
      expect(replySpy).toHaveBeenCalledTimes(1);
      if (topicId === "1") {
        const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy call");
        expect(payload.ReplyChain).toBeUndefined();
      }
      const hiddenMessage = latestConversationContextMessages().find(
        (message) => message.message_id === "102",
      );
      expect(hiddenMessage?.media_ref).toBe(`telegram:file/${photoId}`);
      expect(hiddenMessage?.media_path).toBeUndefined();
      expect(getFileSpy).not.toHaveBeenCalled();
      expect(mediaFetch).not.toHaveBeenCalled();
    },
  );

  it("does not hydrate a sender removed from the refreshed runtime allowlist", async () => {
    const chatId = -1009;
    const runtimeConfig = makeTelegramConfig(
      {
        groupPolicy: "open",
        contextVisibility: "allowlist",
        groupAllowFrom: ["1"],
        groups: { [String(chatId)]: { requireMention: false } },
      },
      { messages: { inbound: { debounceMs: 0 } } },
    );
    const startupConfig = makeTelegramConfig(
      {
        groupPolicy: "open",
        groupAllowFrom: ["1", "2"],
        groups: { [String(chatId)]: { requireMention: false } },
      },
      { messages: { inbound: { debounceMs: 0 } } },
    );
    loadConfig.mockReturnValue(runtimeConfig);

    const mediaFetch = vi.fn(async () => pngResponse());
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const runtimeExit = vi.fn();
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      const handler = await createMessageHandler({
        config: startupConfig,
        runtime: { log: runtimeLog, error: runtimeError, exit: runtimeExit },
        telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
      });
      const chat = { id: chatId, type: "group", title: "Ops" };
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: getEmptyTelegramFile,
        message: {
          chat,
          message_id: 103,
          text: "@openclaw_bot explain this",
          date: 1736380800,
          from: { id: 1, is_bot: false, first_name: "Allowed" },
          reply_to_message: {
            chat,
            message_id: 102,
            caption: "allowed image",
            date: 1736380750,
            from: { id: 2, is_bot: false, first_name: "Also allowed" },
            photo: [{ file_id: "allowed-photo-1" }],
          },
        },
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(runtimeError).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    const messages = latestConversationContextMessages();
    const replyMessage = messages.find((message) => message.message_id === "102");
    expect(replyMessage?.media_path).toBeUndefined();
    expect(replyMessage?.media_ref).toBe("telegram:file/allowed-photo-1");
    expect(getFileSpy).not.toHaveBeenCalled();
    expect(mediaFetch).not.toHaveBeenCalled();
  });

  it("defers reply media download until debounce flush", async () => {
    const DEBOUNCE_MS = 4321;
    const botShutdown = new AbortController();
    const mediaAbort = new AbortController();
    mockTelegramConfig(
      { dmPolicy: "open", allowFrom: ["*"] },
      {
        agents: { defaults: { userTimezone: "UTC" } },
        messages: { inbound: { debounceMs: DEBOUNCE_MS } },
      },
    );

    const mediaFetch = vi.fn(async () => pngResponse());
    const ssrfMock = mockPinnedHostnameResolution();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      const handler = await createMessageHandler({
        fetchAbortSignal: botShutdown.signal,
        mediaAbortSignal: mediaAbort.signal,
        telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
      });

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "first",
          date: 1736380800,
          message_id: 101,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            chat: { id: 7, type: "private", first_name: "Ada" },
            date: 1736380700,
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "second",
          date: 1736380801,
          message_id: 102,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            chat: { id: 7, type: "private", first_name: "Ada" },
            date: 1736380700,
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();
      await replyDelivered;

      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
      expect(mediaFetch).toHaveBeenCalled();
      const replyGetFileSignal = mockArg(getFileSpy, 0, 1, "reply getFile signal");
      if (!(replyGetFileSignal instanceof AbortSignal)) {
        throw new Error("Expected reply media abort signal");
      }
      expect(replyGetFileSignal.aborted).toBe(false);
      mediaAbort.abort();
      expect(replyGetFileSignal.aborted).toBe(true);
      expect(botShutdown.signal.aborted).toBe(false);
    } finally {
      mediaAbort.abort();
      botShutdown.abort();
      setTimeoutSpy.mockRestore();
      ssrfMock.mockRestore();
    }
  });

  it.each([
    {
      name: "quote-only replies without reply metadata",
      message: { text: "Sure, see below", quote: { text: "summarize this" } },
      expectedContext: { ReplyToBody: "summarize this", ReplyToSender: "unknown sender" },
      bodyFragments: ["[Reply chain - nearest first]", "[1. unknown sender", '"summarize this"'],
      expectNoReplyId: true,
      resetMocks: false,
    },
    {
      name: "forwarded origin from external reply targets",
      message: {
        text: "Thoughts?",
        external_reply: {
          message_id: 9003,
          text: "forwarded text",
          from: { first_name: "Ada" },
          quote: { text: "forwarded snippet" },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      expectedContext: {
        ReplyToForwardedFrom: "Bob Smith (@bobsmith)",
        ReplyToForwardedFromType: "user",
        ReplyToForwardedFromId: "999",
        ReplyToForwardedFromUsername: "bobsmith",
        ReplyToForwardedFromTitle: "Bob Smith",
        ReplyToForwardedDate: 500000,
      },
      bodyFragments: ["[Forwarded from Bob Smith (@bobsmith) at 1970-01-01T00:08:20.000Z]"],
      expectNoReplyId: false,
      resetMocks: true,
    },
  ] satisfies Array<{
    name: string;
    message: Record<string, unknown>;
    expectedContext: Partial<MsgContext>;
    bodyFragments: string[];
    expectNoReplyId: boolean;
    resetMocks: boolean;
  }>)(
    "preserves $name",
    async ({ message, expectedContext, bodyFragments, expectNoReplyId, resetMocks }) => {
      if (resetMocks) {
        onSpy.mockReset();
        sendMessageSpy.mockReset();
        replySpy.mockReset();
      }
      const handler = await createMessageHandler();
      await handler({
        message: { chat: { id: 7, type: "private" }, date: 1736380800, ...message },
        me: { username: "openclaw_bot" },
        getFile: getEmptyTelegramFile,
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy call");
      expect(payload).toMatchObject(expectedContext);
      for (const fragment of bodyFragments) {
        expect(payload.Body).toContain(fragment);
      }
      if (expectNoReplyId) {
        expect(payload.ReplyToId).toBeUndefined();
      }
    },
  );

  it("keeps fetched media for uncached external replies", async () => {
    const mediaFetch = vi.fn(async () => pngResponse());
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      const handler = await createMessageHandler({
        telegramTransport: makeTelegramTransport(mediaFetch as typeof fetch),
      });

      await handler({
        message: {
          message_id: 9004,
          chat: { id: 7, type: "private", first_name: "Reader" },
          from: { id: 7, is_bot: false, first_name: "Reader" },
          text: "What is in this image?",
          date: 1736380800,
          external_reply: {
            origin: {
              type: "user",
              sender_user: { id: 22, is_bot: false, first_name: "Ada" },
              date: 1736380700,
            },
            chat: { id: -10022, type: "supergroup", title: "Source" },
            message_id: 9003,
            photo: [
              {
                file_id: "external-photo-1",
                file_unique_id: "external-photo-u1",
                width: 1,
                height: 1,
              },
            ],
          },
        },
        me: { username: "openclaw_bot" },
        getFile: getEmptyTelegramFile,
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy call") as {
      ReplyChain?: Array<{ messageId?: string; mediaPath?: string }>;
    };
    expect(payload.ReplyChain?.[0]).toMatchObject({ messageId: "9003" });
    expect(payload.ReplyChain?.[0]?.mediaPath).toBeTypeOf("string");
    expect(getFileSpy).toHaveBeenCalledWith("external-photo-1", expect.any(AbortSignal));
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "bot API", callbackId: "cbq-codex-delete", businessConnectionId: undefined },
    {
      name: "business connection",
      callbackId: "business-callback-delete",
      businessConnectionId: "business-delete-1",
    },
  ])(
    "deletes plugin-owned callback messages through their $name",
    async ({ callbackId, businessConnectionId }) => {
      const callbackHandler = await createTelegramPluginCallbackHandler({
        handler: (async ({ respond }: TelegramInteractiveHandlerContext) => {
          await respond.deleteMessage();
          return { handled: true };
        }) as never,
      });

      await callbackHandler(
        createTelegramCallbackContext({
          id: callbackId,
          data: "codexapp:delete:thread-1",
          message: {
            ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
            message_id: 11,
            text: "Select a thread",
          },
        }),
      );

      if (businessConnectionId) {
        expect(deleteBusinessMessagesSpy).toHaveBeenCalledWith(businessConnectionId, [11]);
        expect(deleteMessageSpy).not.toHaveBeenCalled();
      } else {
        expect(deleteMessageSpy).toHaveBeenCalledWith(1234, 11);
      }
      expect(replySpy).not.toHaveBeenCalled();
    },
  );

  it("routes plugin-owned callback replies with Telegram topic params", async () => {
    const callbackHandler = await createTelegramPluginCallbackHandler({
      handler: (async ({ respond }: TelegramInteractiveHandlerContext) => {
        await respond.reply({ text: "Handled in topic" });
        return { handled: true };
      }) as never,
    });

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-codex-topic-reply",
        data: "codexapp:reply:thread-1",
        message: {
          business_connection_id: "biz-topic-1",
          chat: { id: -100987654321, type: "supergroup", title: "Forum Group" },
          is_topic_message: true,
          message_id: 11,
          message_thread_id: 99,
          text: "Select a thread",
        },
      }),
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(-100987654321, "Handled in topic", {
      business_connection_id: "biz-topic-1",
      message_thread_id: 99,
    });

    sendMessageSpy.mockClear();
    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-codex-general-reply",
        data: "codexapp:reply:thread-1",
        message: {
          chat: { id: -100987654322, type: "supergroup", title: "Forum Group" },
          is_topic_message: true,
          message_id: 12,
          message_thread_id: 1,
          text: "Select a thread",
        },
      }),
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(-100987654322, "Handled in topic", undefined);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("does not submit plugin-owned callback text when the handler declines the callback", async () => {
    const handler = vi.fn(async () => ({ handled: false, submitText: "Ignore this" }));
    setTelegramPluginStateRuntimeForTests();

    try {
      const callbackHandler = await createTelegramPluginCallbackHandler({
        pluginId: "smart-replies-plugin",
        namespace: "openclaw-smart-replies",
        handler,
      });
      await callbackHandler(
        createTelegramCallbackContext({
          id: "cbq-smart-reply-declined-submit",
          data: "openclaw-smart-replies:v1:SWdub3JlIHRoaXM",
          message: {
            chat: { id: 9, type: "private" },
            message_id: 11,
            text: "Pick a direction",
          },
        }),
      );
    } finally {
      clearTelegramRuntime();
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy call");
    expect(payload.Body).toContain("callback_data: openclaw-smart-replies");
    expect(payload.Body).not.toContain("Ignore this");
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
  });

  it("does not retry plugin-owned callback text skipped by inbound policy", async () => {
    const handler = vi.fn(async () => {
      // The callback was authorized before this policy change; submitText must
      // still honor the fresh inbound policy without releasing callback dedupe.
      mockTelegramConfig({
        dmPolicy: "open",
        allowFrom: ["*"],
        direct: { "9": { requireTopic: true } },
      });
      return { handled: true, submitText: "Do not submit this" };
    });
    setTelegramPluginStateRuntimeForTests();
    try {
      const callbackHandler = await createTelegramPluginCallbackHandler({
        pluginId: "smart-replies-plugin",
        namespace: "openclaw-smart-replies",
        handler,
        config: makeTelegramConfig({
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: { inlineButtons: "dm" },
        }),
      });
      const callbackContext = createTelegramCallbackContext({
        id: "cbq-smart-reply-policy-skip",
        data: "openclaw-smart-replies:v1:RG8gbm90IHN1Ym1pdCB0aGlz",
        message: {
          chat: { id: 9, type: "private" },
          message_id: 11,
          text: "Pick a direction",
        },
      });

      await expect(callbackHandler(callbackContext)).resolves.toBeUndefined();
      await expect(callbackHandler(callbackContext)).resolves.toBeUndefined();

      expect(handler).toHaveBeenCalledOnce();
      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    } finally {
      clearTelegramRuntime();
    }
  });

  it("settles spooled plugin callback text after dispatch succeeds", async () => {
    replySpy.mockImplementation(async (_ctx, opts) => {
      await opts?.onReplyStart?.();
      return undefined;
    });
    setTelegramPluginStateRuntimeForTests();

    try {
      const callbackHandler = await createTelegramPluginCallbackHandler({
        pluginId: "smart-replies-plugin",
        namespace: "openclaw-smart-replies",
        handler: async () => ({ handled: true, submitText: "Make Alice funnier" }),
      });
      const callbackQuery = makeCallbackQuery({
        id: "cbq-smart-reply-submit",
        data: "openclaw-smart-replies:v1:TWFrZSBBbGljZSBmdW5uaWVy",
        message: {
          chat: { id: 9, type: "private" },
          message_id: 11,
          text: "Pick a direction",
        },
      });
      const update = { update_id: 403, callback_query: callbackQuery };
      const callbackContext = {
        update,
        callbackQuery,
        me: { username: "openclaw_bot" },
        getFile: getEmptyTelegramFile,
      };

      const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
        await callbackHandler(callbackContext);
      });
      expect(replay.deferredWork).toBeDefined();
      await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    } finally {
      clearTelegramRuntime();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(9, 11, {
      reply_markup: { inline_keyboard: [] },
    });
    const payload = mockMsgContextArg(replySpy, 0, 0, "replySpy submit call");
    expect(payload.Body).toContain("Make Alice funnier");
  });

  it("releases plugin-owned callback dedupe when submitted text processing fails", async () => {
    let calls = 0;
    replySpy.mockImplementation(async (_ctx, opts) => {
      calls += 1;
      await opts?.onReplyStart?.();
      if (calls === 1) {
        throw new Error("transient submit failure");
      }
      return undefined;
    });
    const handler = vi.fn(async () => ({ handled: true, submitText: "Try this later" }));
    setTelegramPluginStateRuntimeForTests();

    try {
      const callbackHandler = await createTelegramPluginCallbackHandler({
        pluginId: "smart-replies-plugin",
        namespace: "openclaw-smart-replies",
        handler,
      });
      const createCallbackUpdate = (updateId: number) => ({
        update_id: updateId,
        ...createTelegramCallbackContext({
          id: "cbq-smart-reply-submit-fail",
          data: "openclaw-smart-replies:v1:VHJ5IHRoaXMgbGF0ZXI",
          message: {
            chat: { id: 9, type: "private" },
            message_id: 11,
            text: "Pick a direction",
          },
        }),
      });

      await expect(callbackHandler(createCallbackUpdate(401))).rejects.toThrow(
        "transient submit failure",
      );
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();

      await callbackHandler(createCallbackUpdate(402));
    } finally {
      clearTelegramRuntime();
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(9, 11, {
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("passes false command auth to Telegram plugin callbacks for non-allowlisted group senders", async () => {
    const pluginId = "qa-telegram-interactive-binding";
    const pluginRoot = "/plugins/qa-telegram-interactive-binding";
    const conversationId = "-100999:topic:99";
    let binding: SessionBindingRecord | null = null;
    const bind = vi.fn<NonNullable<SessionBindingAdapter["bind"]>>(async (input) => {
      binding = {
        bindingId: "qa-telegram-interactive-binding",
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active",
        boundAt: 1,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      return binding;
    });
    const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>((ref) =>
      binding?.conversation.conversationId === ref.conversationId ? binding : null,
    );
    const unbind = vi.fn<NonNullable<SessionBindingAdapter["unbind"]>>(async (input) => {
      if (!binding || input.bindingId !== binding.bindingId) {
        return [];
      }
      const removed = binding;
      binding = null;
      return [removed];
    });
    const adapter: SessionBindingAdapter = {
      channel: "telegram",
      accountId: "default",
      capabilities: { bindSupported: true, unbindSupported: true, placements: ["current"] },
      bind,
      listBySession: () => [],
      resolveByConversation,
      unbind,
    };
    let observed:
      | {
          auth: TelegramInteractiveHandlerContext["auth"];
          request: Awaited<
            ReturnType<TelegramInteractiveHandlerContext["requestConversationBinding"]>
          >;
          current: Awaited<
            ReturnType<TelegramInteractiveHandlerContext["getCurrentConversationBinding"]>
          >;
          detach: Awaited<
            ReturnType<TelegramInteractiveHandlerContext["detachConversationBinding"]>
          >;
        }
      | undefined;
    const handler = vi.fn(async (context: TelegramInteractiveHandlerContext) => {
      observed = {
        auth: context.auth,
        request: await context.requestConversationBinding({ summary: "Refresh this topic" }),
        current: await context.getCurrentConversationBinding(),
        detach: await context.detachConversationBinding(),
      };
      return { handled: true };
    });

    const config = makeTelegramConfig(
      {
        dmPolicy: "open",
        capabilities: { inlineButtons: "group" },
        groupPolicy: "open",
        groups: { "*": { requireMention: false } },
      },
      { commands: { allowFrom: { telegram: ["111111111"] } } },
    );
    loadConfig.mockReturnValue(config);

    const callbackHandler = await createTelegramPluginCallbackHandler({
      handler: handler as never,
      config,
      pluginId,
      pluginRoot,
    });
    registerSessionBindingAdapter(adapter);
    try {
      await bind({
        targetSessionKey: "agent:qa:telegram:interactive-binding",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId,
          parentConversationId: "-100999",
        },
        metadata: { pluginBindingOwner: "plugin", pluginId, pluginRoot },
      });
      bind.mockClear();
      resolveByConversation.mockClear();
      unbind.mockClear();

      await callbackHandler(
        createTelegramCallbackContext({
          id: "cbq-plugin-auth-false",
          data: "codexapp:resume:thread-1",
          from: { id: 999999999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group", is_forum: true },
            message_id: 22,
            message_thread_id: 99,
            is_topic_message: true,
            text: "Select a thread",
          },
        }),
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(observed?.auth.isAuthorizedSender).toBe(false);
      expect(observed?.request).toMatchObject({ status: "error" });
      expect(observed?.current).toBeNull();
      expect(observed?.detach).toEqual({ removed: false });
      expect(bind).not.toHaveBeenCalled();
      expect(resolveByConversation).not.toHaveBeenCalled();
      expect(unbind).not.toHaveBeenCalled();
    } finally {
      unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
    }
  });

  it("passes true command auth to Telegram plugin callbacks for access-group DM senders", async () => {
    let observedAuth: TelegramInteractiveHandlerContext["auth"] | undefined;
    const handler = vi.fn(async ({ auth }: TelegramInteractiveHandlerContext) => {
      observedAuth = auth;
      return { handled: true };
    });

    const config = makeTelegramConfig(
      {
        dmPolicy: "allowlist",
        allowFrom: ["accessGroup:operators"],
        capabilities: { inlineButtons: "dm" },
      },
      {
        accessGroups: {
          operators: {
            type: "message.senders",
            members: { telegram: ["123456789"] },
          },
        },
      },
    );
    loadConfig.mockReturnValue(config);

    const callbackHandler = await createTelegramPluginCallbackHandler({
      handler: handler as never,
      config,
    });

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-plugin-access-group-auth",
        data: "codexapp:resume:thread-1",
        from: { id: 123456789, first_name: "Ada", username: "ada" },
        message: {
          chat: { id: 123456789, type: "private" },
          message_id: 24,
          text: "Select a thread",
        },
      }),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(observedAuth?.isAuthorizedSender).toBe(true);
  });

  it("routes Telegram #General callback payloads as topic 1 when Telegram omits topic metadata", async () => {
    getChatSpy.mockResolvedValue({ id: -100123456789, type: "supergroup", is_forum: true });
    const handler = vi.fn(
      async ({ respond, conversationId, threadId }: TelegramInteractiveHandlerContext) => {
        expect(conversationId).toBe("-100123456789:topic:1");
        expect(threadId).toBe(1);
        await respond.editMessage({
          text: `Handled ${conversationId}`,
        });
        return { handled: true };
      },
    );
    const callbackHandler = await createTelegramPluginCallbackHandler({
      handler: handler as never,
    });

    await callbackHandler(
      createTelegramCallbackContext({
        id: "cbq-codex-general",
        data: "codexapp:resume:thread-1",
        message: {
          chat: { id: -100123456789, type: "supergroup", title: "Forum Group" },
          message_id: 11,
          text: "Select a thread",
        },
      }),
    );

    expect(getChatSpy).toHaveBeenCalledWith(-100123456789);
    expect(handler).toHaveBeenCalledOnce();
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      -100123456789,
      11,
      "Handled -100123456789:topic:1",
      undefined,
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
