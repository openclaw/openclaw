// Telegram plugin module implements bot.create telegram bot harness behavior.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  useBundledProviderPolicyArtifactsForTest,
  type MockFn,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { GetReplyOptions, MsgContext, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  runTelegramChannelInboundEventWithHarness,
  type TelegramTestMiddleware,
} from "./bot.test-helpers.js";
import {
  clearTelegramSessionStateFilesForTests,
  setTelegramPluginStateRuntimeForTests,
} from "./runtime-state.test-support.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic", "amazon-bedrock"]);

type AnyMock = ReturnType<typeof vi.fn>;
type AnyAsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
type TelegramBotRuntimeForTest = typeof import("./bot.runtime.js");
type GetRuntimeConfigFn =
  typeof import("openclaw/plugin-sdk/runtime-config-snapshot").getRuntimeConfig;
type GetSessionEntryFn = typeof import("openclaw/plugin-sdk/session-store-runtime").getSessionEntry;
type ResolveStorePathFn =
  typeof import("openclaw/plugin-sdk/session-store-runtime").resolveStorePath;
type ReadSessionUpdatedAtFn =
  typeof import("openclaw/plugin-sdk/session-store-runtime").readSessionUpdatedAt;
type LoadWebMediaFn = typeof import("openclaw/plugin-sdk/web-media").loadWebMedia;
type ResolveTelegramApprovalForTest = NonNullable<TelegramBotDeps["resolveApproval"]>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DispatchReplyHarnessParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type ReplyPayloadLike = ReplyPayload;
type ReplySpyResult = ReplyPayloadLike | ReplyPayloadLike[] | undefined;
type ReplySpy = (ctx: MsgContext, opts?: GetReplyOptions) => Promise<ReplySpyResult>;

const { sessionStorePath } = vi.hoisted(() => {
  const tempRoot =
    process.platform === "win32"
      ? (process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp")
      : (process.env.TMPDIR ?? "/tmp");
  const separator = process.platform === "win32" ? "\\" : "/";
  return {
    sessionStorePath: `${tempRoot.replace(/[\\/]+$/u, "")}${separator}openclaw-telegram-${
      process.pid
    }-${process.env.VITEST_POOL_ID ?? "0"}.json`,
  };
});

const { loadWebMedia } = vi.hoisted((): { loadWebMedia: MockFn<LoadWebMediaFn> } => ({
  loadWebMedia: vi.fn<LoadWebMediaFn>(),
}));

export function getLoadWebMediaMock(): MockFn<LoadWebMediaFn> {
  return loadWebMedia;
}

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia,
}));

const {
  getSessionEntryMock,
  getRuntimeConfig,
  readSessionUpdatedAtMock,
  recordInboundSessionMock,
  resolveStorePathMock,
} = vi.hoisted(
  (): {
    getSessionEntryMock: MockFn<GetSessionEntryFn>;
    getRuntimeConfig: MockFn<GetRuntimeConfigFn>;
    readSessionUpdatedAtMock: MockFn<ReadSessionUpdatedAtFn>;
    recordInboundSessionMock: MockFn<NonNullable<TelegramBotDeps["recordInboundSession"]>>;
    resolveStorePathMock: MockFn<ResolveStorePathFn>;
  } => ({
    getRuntimeConfig: vi.fn<GetRuntimeConfigFn>(() => ({})),
    resolveStorePathMock: vi.fn<ResolveStorePathFn>(
      (storePath?: string) => storePath ?? sessionStorePath,
    ),
    getSessionEntryMock: vi.fn<GetSessionEntryFn>(() => undefined),
    readSessionUpdatedAtMock: vi.fn<ReadSessionUpdatedAtFn>(() => undefined),
    recordInboundSessionMock: vi.fn(async () => undefined),
  }),
);

export function getLoadConfigMock(): AnyMock {
  return getRuntimeConfig;
}

const { readChannelAllowFromStore, upsertChannelPairingRequest } = vi.hoisted(
  (): {
    readChannelAllowFromStore: MockFn<TelegramBotDeps["readChannelAllowFromStore"]>;
    upsertChannelPairingRequest: MockFn<TelegramBotDeps["upsertChannelPairingRequest"]>;
  } => ({
    readChannelAllowFromStore: vi.fn(async () => [] as string[]),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })),
  }),
);

export function getReadChannelAllowFromStoreMock(): MockFn<
  TelegramBotDeps["readChannelAllowFromStore"]
> {
  return readChannelAllowFromStore;
}

export function getUpsertChannelPairingRequestMock(): MockFn<
  TelegramBotDeps["upsertChannelPairingRequest"]
> {
  return upsertChannelPairingRequest;
}

const skillCommandListHoisted = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn<TelegramBotDeps["listSkillCommandsForAgents"]>(() => []),
}));
const modelProviderDataHoisted = vi.hoisted(() => ({
  buildModelsProviderData: vi.fn() as MockFn<TelegramBotDeps["buildModelsProviderData"]>,
}));
const replySpyHoisted = vi.hoisted(() => ({
  replySpy: vi.fn<ReplySpy>(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  }),
}));

async function dispatchHarnessReplies(
  params: DispatchReplyHarnessParams,
  runReply: (
    params: DispatchReplyHarnessParams,
  ) => Promise<ReplyPayloadLike | ReplyPayloadLike[] | undefined>,
): Promise<DispatchReplyWithBufferedBlockDispatcherResult> {
  await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
  const reply = await runReply(params);
  const payloads: ReplyPayloadLike[] =
    reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
  let finalCount = 0;
  for (const payload of payloads) {
    try {
      await params.dispatcherOptions.deliver?.(payload, { kind: "final" });
      finalCount += 1;
    } catch (err) {
      void params.dispatcherOptions.onError?.(err, { kind: "final" });
    }
  }
  return {
    queuedFinal: finalCount > 0,
    counts: {
      block: 0,
      final: finalCount,
      tool: 0,
    },
  };
}

const dispatchReplyHoisted = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async (params: DispatchReplyHarnessParams) =>
      await dispatchHarnessReplies(params, async (dispatchParams) => {
        return await replySpyHoisted.replySpy(dispatchParams.ctx, dispatchParams.replyOptions);
      }),
  ),
}));
export const dispatchReplyWithBufferedBlockDispatcher =
  dispatchReplyHoisted.dispatchReplyWithBufferedBlockDispatcher;
vi.mock("../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcherCore:
    dispatchReplyHoisted.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      await runTelegramChannelInboundEventWithHarness(
        actual,
        params,
        dispatchReplyWithBufferedBlockDispatcher,
      ),
  };
});
export const listSkillCommandsForAgents = skillCommandListHoisted.listSkillCommandsForAgents;
const buildModelsProviderData = modelProviderDataHoisted.buildModelsProviderData;
export const replySpy = replySpyHoisted.replySpy;
const menuSyncHoisted = vi.hoisted(() => ({
  syncTelegramMenuCommands: vi.fn(async ({ bot, commandsToRegister }) => {
    await bot.api.setMyCommands(commandsToRegister);
  }),
}));
const syncTelegramMenuCommands = menuSyncHoisted.syncTelegramMenuCommands;

const systemEventsHoisted = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn<TelegramBotDeps["enqueueRoutedSystemEvent"]>(() => false),
}));
export const enqueueSystemEventSpy: MockFn<TelegramBotDeps["enqueueRoutedSystemEvent"]> =
  systemEventsHoisted.enqueueSystemEventSpy;
const execApprovalHoisted = vi.hoisted(
  (): { resolveExecApprovalSpy: MockFn<ResolveTelegramApprovalForTest> } => ({
    resolveExecApprovalSpy: vi.fn<ResolveTelegramApprovalForTest>(async () => ({
      applied: true,
      approval: {
        id: "test-approval",
        urlPath: "/approve/test-approval",
        createdAtMs: 1,
        expiresAtMs: 60_000,
        resolvedAtMs: 2,
        reason: "user",
        status: "allowed",
        decision: "allow-once",
        presentation: {
          kind: "exec",
          commandText: "echo test",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    })),
  }),
);
export const resolveExecApprovalSpy: MockFn<ResolveTelegramApprovalForTest> =
  execApprovalHoisted.resolveExecApprovalSpy;

const sentMessageCacheHoisted = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
const wasSentByBot = sentMessageCacheHoisted.wasSentByBot;

vi.doMock("./sent-message-cache.js", () => ({
  wasSentByBot: sentMessageCacheHoisted.wasSentByBot,
  recordSentMessage: vi.fn(),
}));

// All spy variables used inside vi.mock("grammy", ...) must be created via
// vi.hoisted() so they are available when the hoisted factory runs, regardless
// of module evaluation order across different test files.
const grammySpies = vi.hoisted(() => ({
  useSpy: vi.fn() as MockFn<(arg: unknown) => void>,
  middlewareUseSpy: vi.fn(),
  onSpy: vi.fn(),
  stopSpy: vi.fn(),
  commandSpy: vi.fn(),
  botCtorSpy: vi.fn(
    (_token: string, __?: { client?: { fetch?: typeof fetch }; botInfo?: unknown }) => undefined,
  ),
  answerCallbackQuerySpy: vi.fn(async () => undefined) as AnyAsyncMock,
  sendChatActionSpy: vi.fn(),
  editMessageTextSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  editMessageReplyMarkupSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  deleteMessageSpy: vi.fn(async () => true) as AnyAsyncMock,
  deleteBusinessMessagesSpy: vi.fn(async () => true) as AnyAsyncMock,
  setMessageReactionSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  setMyCommandsSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  getMeSpy: vi.fn(async () => ({
    username: "openclaw_bot",
    has_topics_enabled: true,
  })) as AnyAsyncMock,
  getChatSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  sendMessageSpy: vi.fn(async () => ({ message_id: 77 })) as AnyAsyncMock,
  sendAnimationSpy: vi.fn(async () => ({ message_id: 78 })) as AnyAsyncMock,
  sendPhotoSpy: vi.fn(async () => ({ message_id: 79 })) as AnyAsyncMock,
  getFileSpy: vi.fn(async () => ({ file_path: "media/file.jpg" })) as AnyAsyncMock,
}));

export const useSpy: MockFn<(arg: unknown) => void> = grammySpies.useSpy;
export const middlewareUseSpy: AnyMock = grammySpies.middlewareUseSpy;
export const onSpy: AnyMock = grammySpies.onSpy;
const stopSpy: AnyMock = grammySpies.stopSpy;
export const commandSpy: AnyMock = grammySpies.commandSpy;
export const botCtorSpy: MockFn<
  (token: string, options?: { client?: { fetch?: typeof fetch }; botInfo?: unknown }) => void
> = grammySpies.botCtorSpy;
export const answerCallbackQuerySpy: AnyAsyncMock = grammySpies.answerCallbackQuerySpy;
const sendChatActionSpy: AnyMock = grammySpies.sendChatActionSpy;
export const editMessageTextSpy: AnyAsyncMock = grammySpies.editMessageTextSpy;
export const editMessageReplyMarkupSpy: AnyAsyncMock = grammySpies.editMessageReplyMarkupSpy;
export const deleteMessageSpy: AnyAsyncMock = grammySpies.deleteMessageSpy;
export const deleteBusinessMessagesSpy: AnyAsyncMock = grammySpies.deleteBusinessMessagesSpy;
const setMessageReactionSpy: AnyAsyncMock = grammySpies.setMessageReactionSpy;
const setMyCommandsSpy: AnyAsyncMock = grammySpies.setMyCommandsSpy;
export const getChatSpy: AnyAsyncMock = grammySpies.getChatSpy;
export const sendMessageSpy: AnyAsyncMock = grammySpies.sendMessageSpy;
const sendAnimationSpy: AnyAsyncMock = grammySpies.sendAnimationSpy;
const sendPhotoSpy: AnyAsyncMock = grammySpies.sendPhotoSpy;
export const getFileSpy: AnyAsyncMock = grammySpies.getFileSpy;

type RichMessageParams = {
  chat_id?: string | number;
  message_id?: number;
  rich_message?: {
    blocks?: Array<{ type?: string; text?: unknown }>;
    markdown?: string;
    html?: string;
  };
  [key: string]: unknown;
};

function getRichMessageText(params: RichMessageParams): string {
  const rich = params.rich_message;
  if (!rich) {
    return "";
  }
  if (rich.blocks) {
    // Test harness only needs a readable plain-ish projection for assertions.
    return rich.blocks
      .map((block) => {
        if (typeof block.text === "string") {
          return block.text;
        }
        return JSON.stringify(block.text ?? "");
      })
      .join("\n");
  }
  return rich.markdown ?? rich.html ?? "";
}

const runnerHoisted = vi.hoisted(() => ({
  sequentializeMiddleware: vi.fn(async (_ctx: unknown, next?: () => Promise<void>) => {
    if (typeof next === "function") {
      await next();
    }
  }),
  sequentializeSpy: vi.fn(() => runnerHoisted.sequentializeMiddleware),
  throttlerSpy: vi.fn(() => "throttler"),
}));
export const sequentializeSpy: AnyMock = runnerHoisted.sequentializeSpy;
export let sequentializeKey: ((ctx: unknown) => string | string[] | undefined) | undefined;
export const throttlerSpy: AnyMock = runnerHoisted.throttlerSpy;
const telegramBotRuntimeForTest = {
  Bot: class {
    api = {
      config: { use: grammySpies.useSpy },
      answerCallbackQuery: grammySpies.answerCallbackQuerySpy,
      sendChatAction: grammySpies.sendChatActionSpy,
      editMessageText: grammySpies.editMessageTextSpy,
      editMessageReplyMarkup: grammySpies.editMessageReplyMarkupSpy,
      deleteMessage: grammySpies.deleteMessageSpy,
      deleteBusinessMessages: grammySpies.deleteBusinessMessagesSpy,
      setMessageReaction: grammySpies.setMessageReactionSpy,
      setMyCommands: grammySpies.setMyCommandsSpy,
      getMe: grammySpies.getMeSpy,
      getChat: grammySpies.getChatSpy,
      getChatMember: grammySpies.getChatSpy,
      sendMessage: grammySpies.sendMessageSpy,
      sendAnimation: grammySpies.sendAnimationSpy,
      sendPhoto: grammySpies.sendPhotoSpy,
      getFile: grammySpies.getFileSpy,
      raw: {
        sendRichMessage: async (params: RichMessageParams) => {
          const {
            chat_id,
            message_id: _messageId,
            rich_message: _richMessage,
            ...options
          } = params;
          return grammySpies.sendMessageSpy(chat_id, getRichMessageText(params), options);
        },
        editMessageText: async (params: RichMessageParams) => {
          const { chat_id, message_id, rich_message: _richMessage, ...options } = params;
          return grammySpies.editMessageTextSpy(
            chat_id,
            message_id,
            getRichMessageText(params),
            options,
          );
        },
      },
    };
    use = grammySpies.middlewareUseSpy;
    on = grammySpies.onSpy;
    stop = grammySpies.stopSpy;
    command = (name: string, handler: TelegramTestMiddleware) =>
      grammySpies.commandSpy(
        name,
        async (ctx: Record<string, unknown>, next?: () => Promise<void>) =>
          await handler(
            ctx,
            next ??
              (async () =>
                await getOnHandler("message")({
                  me: { id: 9876543210, username: "openclaw_bot" },
                  getFile: async () => ({}),
                  ...ctx,
                })),
          ),
      );
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch }; botInfo?: unknown },
    ) {
      (grammySpies.botCtorSpy as unknown as (token: string, options?: unknown) => void)(
        token,
        options,
      );
    }
  } as unknown as TelegramBotRuntimeForTest["Bot"],
  sequentialize: ((keyFn: (ctx: unknown) => string | string[] | undefined) => {
    sequentializeKey = keyFn;
    return (
      runnerHoisted.sequentializeSpy as unknown as () => ReturnType<
        TelegramBotRuntimeForTest["sequentialize"]
      >
    )();
  }) as unknown as TelegramBotRuntimeForTest["sequentialize"],
  apiThrottler: (() =>
    (
      runnerHoisted.throttlerSpy as unknown as () => unknown
    )()) as unknown as TelegramBotRuntimeForTest["apiThrottler"],
};
export const telegramBotDepsForTest: TelegramBotDeps = {
  getRuntimeConfig,
  getSessionEntry: getSessionEntryMock,
  resolveStorePath: resolveStorePathMock,
  readSessionUpdatedAt: readSessionUpdatedAtMock,
  recordInboundSession: recordInboundSessionMock as TelegramBotDeps["recordInboundSession"],
  recordChannelActivity: vi.fn() as TelegramBotDeps["recordChannelActivity"],
  resolveInboundLastRouteSessionKey: ({ route, sessionKey }) =>
    route.lastRoutePolicy === "main" ? route.mainSessionKey : sessionKey,
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  buildChannelInboundEventContext,
  readChannelAllowFromStore:
    readChannelAllowFromStore as TelegramBotDeps["readChannelAllowFromStore"],
  upsertChannelPairingRequest:
    upsertChannelPairingRequest as TelegramBotDeps["upsertChannelPairingRequest"],
  enqueueRoutedSystemEvent: enqueueSystemEventSpy as TelegramBotDeps["enqueueRoutedSystemEvent"],
  dispatchReplyWithBufferedBlockDispatcher,
  loadWebMedia: loadWebMedia as TelegramBotDeps["loadWebMedia"],
  buildModelsProviderData: buildModelsProviderData as TelegramBotDeps["buildModelsProviderData"],
  listSkillCommandsForAgents:
    listSkillCommandsForAgents as TelegramBotDeps["listSkillCommandsForAgents"],
  syncTelegramMenuCommands: syncTelegramMenuCommands as TelegramBotDeps["syncTelegramMenuCommands"],
  wasSentByBot: wasSentByBot as TelegramBotDeps["wasSentByBot"],
  resolveApproval: resolveExecApprovalSpy,
};

vi.doMock("./bot.runtime.js", () => telegramBotRuntimeForTest);

export const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) {
    throw new Error(`Missing handler for event: ${event}`);
  }
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

const DEFAULT_TELEGRAM_TEST_CONFIG: OpenClawConfig = {
  messages: { inbound: { debounceMs: 0 } },
  agents: {
    defaults: {
      userTimezone: "UTC",
    },
  },
  channels: {
    telegram: { dmPolicy: "open", allowFrom: ["*"] },
  },
};

beforeEach(() => {
  resetTelegramMessageCacheForTest();
  setTelegramPluginStateRuntimeForTests();
  getRuntimeConfig.mockReset();
  getRuntimeConfig.mockReturnValue(DEFAULT_TELEGRAM_TEST_CONFIG);
  clearTelegramSessionStateFilesForTests(sessionStorePath);
  resolveStorePathMock.mockReset();
  resolveStorePathMock.mockImplementation((storePath?: string) => storePath ?? sessionStorePath);
  getSessionEntryMock.mockReset();
  getSessionEntryMock.mockReturnValue(undefined);
  readSessionUpdatedAtMock.mockReset();
  readSessionUpdatedAtMock.mockReturnValue(undefined);
  recordInboundSessionMock.mockReset();
  recordInboundSessionMock.mockResolvedValue(undefined);
  loadWebMedia.mockReset();
  readChannelAllowFromStore.mockReset();
  readChannelAllowFromStore.mockResolvedValue([]);
  upsertChannelPairingRequest.mockReset();
  upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRCODE", created: true } as const);
  onSpy.mockReset();
  commandSpy.mockReset();
  stopSpy.mockReset();
  useSpy.mockReset();
  replySpy.mockReset();
  replySpy.mockImplementation(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  resolveExecApprovalSpy.mockReset();
  resolveExecApprovalSpy.mockResolvedValue({
    applied: true,
    approval: {
      id: "test-approval",
      urlPath: "/approve/test-approval",
      createdAtMs: 1,
      expiresAtMs: 60_000,
      resolvedAtMs: 2,
      reason: "user",
      status: "allowed",
      decision: "allow-once",
      presentation: {
        kind: "exec",
        commandText: "echo test",
        allowedDecisions: ["allow-once", "deny"],
      },
    },
  });
  dispatchReplyWithBufferedBlockDispatcher.mockReset();
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
    async (params: DispatchReplyHarnessParams) =>
      await dispatchHarnessReplies(params, async (dispatchParams) => {
        return await replySpy(dispatchParams.ctx, dispatchParams.replyOptions);
      }),
  );
  syncTelegramMenuCommands.mockReset();
  syncTelegramMenuCommands.mockImplementation(async ({ bot, commandsToRegister }) => {
    await bot.api.setMyCommands(commandsToRegister);
  });

  sendAnimationSpy.mockReset();
  sendAnimationSpy.mockResolvedValue({ message_id: 78 });
  sendPhotoSpy.mockReset();
  sendPhotoSpy.mockResolvedValue({ message_id: 79 });
  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue({ message_id: 77 });
  getFileSpy.mockReset();
  getFileSpy.mockResolvedValue({ file_path: "media/file.jpg" });

  setMessageReactionSpy.mockReset();
  setMessageReactionSpy.mockResolvedValue(undefined);
  answerCallbackQuerySpy.mockReset();
  answerCallbackQuerySpy.mockResolvedValue(undefined);
  sendChatActionSpy.mockReset();
  sendChatActionSpy.mockResolvedValue(undefined);
  setMyCommandsSpy.mockReset();
  setMyCommandsSpy.mockResolvedValue(undefined);
  getChatSpy.mockReset();
  getChatSpy.mockResolvedValue(undefined);
  grammySpies.getMeSpy.mockReset();
  grammySpies.getMeSpy.mockResolvedValue({
    username: "openclaw_bot",
    has_topics_enabled: true,
  });
  editMessageTextSpy.mockReset();
  editMessageTextSpy.mockResolvedValue({ message_id: 88 });
  editMessageReplyMarkupSpy.mockReset();
  editMessageReplyMarkupSpy.mockResolvedValue({ message_id: 88 });
  deleteMessageSpy.mockReset();
  deleteMessageSpy.mockResolvedValue(true);
  deleteBusinessMessagesSpy.mockReset();
  deleteBusinessMessagesSpy.mockResolvedValue(true);
  enqueueSystemEventSpy.mockReset();
  wasSentByBot.mockReset();
  wasSentByBot.mockReturnValue(false);
  listSkillCommandsForAgents.mockReset();
  listSkillCommandsForAgents.mockReturnValue([]);
  buildModelsProviderData.mockReset();
  buildModelsProviderData.mockResolvedValue({
    byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
    providers: ["openai"],
    resolvedDefault: { provider: "openai", model: "gpt-5.4" },
    modelNames: new Map(),
    modelCatalog: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: false }],
  });
  middlewareUseSpy.mockReset();
  runnerHoisted.sequentializeMiddleware.mockReset();
  runnerHoisted.sequentializeMiddleware.mockImplementation(async (_ctx, next) => {
    if (typeof next === "function") {
      await next();
    }
  });
  sequentializeSpy.mockReset();
  sequentializeSpy.mockImplementation(() => runnerHoisted.sequentializeMiddleware);
  botCtorSpy.mockReset();
  sequentializeKey = undefined;
});
