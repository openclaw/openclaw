import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { MockFn } from "openclaw/plugin-sdk/testing";
import { beforeEach, vi } from "vitest";

type AnyMock = MockFn<(...args: unknown[]) => unknown>;
type AnyAsyncMock = MockFn<(...args: unknown[]) => Promise<unknown>>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DispatchReplyHarnessParams = {
  ctx: MsgContext;
  replyOptions?: GetReplyOptions;
  dispatcherOptions?: {
    typingCallbacks?: {
      start?: () => void | Promise<void>;
    };
    deliver?: (payload: ReplyPayload, info: { kind: "final" }) => void | Promise<void>;
  };
};

const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}.json`,
}));

const { loadWebMedia } = vi.hoisted((): { loadWebMedia: AnyMock } => ({
  loadWebMedia: vi.fn(),
}));

export function getLoadWebMediaMock(): AnyMock {
  return loadWebMedia;
}

vi.doMock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia,
}));

const { loadConfig } = vi.hoisted((): { loadConfig: AnyMock } => ({
  loadConfig: vi.fn(() => ({})),
}));
const { resolveStorePathMock } = vi.hoisted((): { resolveStorePathMock: AnyMock } => ({
  resolveStorePathMock: vi.fn((storePath?: string) => storePath ?? sessionStorePath),
}));

export function getLoadConfigMock(): AnyMock {
  return loadConfig;
}
vi.doMock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.doMock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    resolveStorePath: resolveStorePathMock,
  };
});

const { readChannelAllowFromStore, upsertChannelPairingRequest } = vi.hoisted(
  (): {
    readChannelAllowFromStore: AnyAsyncMock;
    upsertChannelPairingRequest: AnyAsyncMock;
  } => ({
    readChannelAllowFromStore: vi.fn(async () => [] as string[]),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })),
  }),
);

export function getReadChannelAllowFromStoreMock(): AnyAsyncMock {
  return readChannelAllowFromStore;
}

export function getUpsertChannelPairingRequestMock(): AnyAsyncMock {
  return upsertChannelPairingRequest;
}

vi.doMock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore,
    upsertChannelPairingRequest,
  };
});

const skillCommandsHoisted = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
  replySpy: vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  }) as MockFn<
    (
      ctx: MsgContext,
      opts?: GetReplyOptions,
      configOverride?: OpenClawConfig,
    ) => Promise<ReplyPayload | ReplyPayload[] | undefined>
  >,
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async (params: DispatchReplyHarnessParams) => {
      const result: DispatchReplyWithBufferedBlockDispatcherResult = {
        queuedFinal: false,
        counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
      };
      await params.dispatcherOptions?.typingCallbacks?.start?.();
      const reply = await skillCommandsHoisted.replySpy(params.ctx, params.replyOptions);
      const payloads = reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
      for (const payload of payloads) {
        await params.dispatcherOptions?.deliver?.(payload, { kind: "final" });
      }
      return result;
    },
  ),
}));
export const listSkillCommandsForAgents = skillCommandsHoisted.listSkillCommandsForAgents;
export const replySpy = skillCommandsHoisted.replySpy;
export const dispatchReplyWithBufferedBlockDispatcher =
  skillCommandsHoisted.dispatchReplyWithBufferedBlockDispatcher;

vi.doMock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    listSkillCommandsForAgents: skillCommandsHoisted.listSkillCommandsForAgents,
    getReplyFromConfig: skillCommandsHoisted.replySpy,
    __replySpy: skillCommandsHoisted.replySpy,
    dispatchReplyWithBufferedBlockDispatcher:
      skillCommandsHoisted.dispatchReplyWithBufferedBlockDispatcher,
  };
});

const systemEventsHoisted = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn(),
}));
export const enqueueSystemEventSpy: AnyMock = systemEventsHoisted.enqueueSystemEventSpy;

vi.doMock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    enqueueSystemEvent: systemEventsHoisted.enqueueSystemEventSpy,
  };
});

const sentMessageCacheHoisted = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
export const wasSentByBot = sentMessageCacheHoisted.wasSentByBot;

vi.doMock("./sent-message-cache.js", () => ({
  wasSentByBot: sentMessageCacheHoisted.wasSentByBot,
  recordSentMessage: vi.fn(),
  clearSentMessageCache: vi.fn(),
}));

// All spy variables used inside vi.mock("grammy", ...) must be created via
// vi.hoisted() so they are available when the hoisted factory runs, regardless
// of module evaluation order across different test files.
const grammySpies = vi.hoisted(() => ({
  useSpy: vi.fn() as MockFn<(arg: unknown) => void>,
  middlewareUseSpy: vi.fn() as AnyMock,
  onSpy: vi.fn() as AnyMock,
  stopSpy: vi.fn() as AnyMock,
  commandSpy: vi.fn() as AnyMock,
  botCtorSpy: vi.fn() as AnyMock,
  answerCallbackQuerySpy: vi.fn(async () => undefined) as AnyAsyncMock,
  sendChatActionSpy: vi.fn() as AnyMock,
  editMessageTextSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  editMessageReplyMarkupSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  sendMessageDraftSpy: vi.fn(async () => true) as AnyAsyncMock,
  setMessageReactionSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  setMyCommandsSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  getMeSpy: vi.fn(async () => ({
    username: "openclaw_bot",
    has_topics_enabled: true,
  })) as AnyAsyncMock,
  sendMessageSpy: vi.fn(async () => ({ message_id: 77 })) as AnyAsyncMock,
  sendAnimationSpy: vi.fn(async () => ({ message_id: 78 })) as AnyAsyncMock,
  sendPhotoSpy: vi.fn(async () => ({ message_id: 79 })) as AnyAsyncMock,
  getFileSpy: vi.fn(async () => ({ file_path: "media/file.jpg" })) as AnyAsyncMock,
}));

export const {
  useSpy,
  middlewareUseSpy,
  onSpy,
  stopSpy,
  commandSpy,
  botCtorSpy,
  answerCallbackQuerySpy,
  sendChatActionSpy,
  editMessageTextSpy,
  editMessageReplyMarkupSpy,
  sendMessageDraftSpy,
  setMessageReactionSpy,
  setMyCommandsSpy,
  getMeSpy,
  sendMessageSpy,
  sendAnimationSpy,
  sendPhotoSpy,
  getFileSpy,
} = grammySpies;

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
export let sequentializeKey: ((ctx: unknown) => string) | undefined;
export const throttlerSpy: AnyMock = runnerHoisted.throttlerSpy;
export const telegramBotRuntimeForTest = {
  Bot: class {
    api = {
      config: { use: grammySpies.useSpy },
      answerCallbackQuery: grammySpies.answerCallbackQuerySpy,
      sendChatAction: grammySpies.sendChatActionSpy,
      editMessageText: grammySpies.editMessageTextSpy,
      editMessageReplyMarkup: grammySpies.editMessageReplyMarkupSpy,
      sendMessageDraft: grammySpies.sendMessageDraftSpy,
      setMessageReaction: grammySpies.setMessageReactionSpy,
      setMyCommands: grammySpies.setMyCommandsSpy,
      getMe: grammySpies.getMeSpy,
      sendMessage: grammySpies.sendMessageSpy,
      sendAnimation: grammySpies.sendAnimationSpy,
      sendPhoto: grammySpies.sendPhotoSpy,
      getFile: grammySpies.getFileSpy,
    };
    use = grammySpies.middlewareUseSpy;
    on = grammySpies.onSpy;
    stop = grammySpies.stopSpy;
    command = grammySpies.commandSpy;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      grammySpies.botCtorSpy(token, options);
    }
  },
  sequentialize: (keyFn: (ctx: unknown) => string) => {
    sequentializeKey = keyFn;
    return runnerHoisted.sequentializeSpy();
  },
  apiThrottler: () => runnerHoisted.throttlerSpy(),
  loadConfig,
};
export const telegramBotMessageDispatchRuntimeForTest = {
  dispatchReplyWithBufferedBlockDispatcher,
};
export const telegramBotNativeCommandsRuntimeForTest = {
  dispatchReplyWithBufferedBlockDispatcher,
  listSkillCommandsForAgents,
};
export const telegramBotHandlersRuntimeForTest = {
  loadConfig,
  resolveStorePath: resolveStorePathMock,
  readChannelAllowFromStore,
  enqueueSystemEvent: enqueueSystemEventSpy,
  listSkillCommandsForAgents,
  wasSentByBot,
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
  agents: {
    defaults: {
      envelopeTimezone: "utc",
    },
  },
  channels: {
    telegram: { dmPolicy: "open", allowFrom: ["*"] },
  },
};

export function makeTelegramMessageCtx(params: {
  chat: {
    id: number;
    type: string;
    title?: string;
    is_forum?: boolean;
  };
  from: { id: number; username?: string };
  text: string;
  date?: number;
  messageId?: number;
  messageThreadId?: number;
}) {
  return {
    message: {
      chat: params.chat,
      from: params.from,
      text: params.text,
      date: params.date ?? 1736380800,
      message_id: params.messageId ?? 42,
      ...(params.messageThreadId === undefined
        ? {}
        : { message_thread_id: params.messageThreadId }),
    },
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

export function makeForumGroupMessageCtx(params?: {
  chatId?: number;
  threadId?: number;
  text?: string;
  fromId?: number;
  username?: string;
  title?: string;
}) {
  return makeTelegramMessageCtx({
    chat: {
      id: params?.chatId ?? -1001234567890,
      type: "supergroup",
      title: params?.title ?? "Forum Group",
      is_forum: true,
    },
    from: { id: params?.fromId ?? 12345, username: params?.username ?? "testuser" },
    text: params?.text ?? "hello",
    messageThreadId: params?.threadId,
  });
}

beforeEach(() => {
  resetInboundDedupe();
  loadConfig.mockReset();
  loadConfig.mockReturnValue(DEFAULT_TELEGRAM_TEST_CONFIG);
  resolveStorePathMock.mockReset();
  resolveStorePathMock.mockImplementation((storePath?: string) => storePath ?? sessionStorePath);
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
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  dispatchReplyWithBufferedBlockDispatcher.mockReset();
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
    async (params: DispatchReplyHarnessParams) => {
      const result: DispatchReplyWithBufferedBlockDispatcherResult = {
        queuedFinal: false,
        counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
      };
      await params.dispatcherOptions?.typingCallbacks?.start?.();
      const reply = await replySpy(params.ctx, params.replyOptions);
      const payloads = reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
      for (const payload of payloads) {
        await params.dispatcherOptions?.deliver?.(payload, { kind: "final" });
      }
      return result;
    },
  );

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
  getMeSpy.mockReset();
  getMeSpy.mockResolvedValue({
    username: "openclaw_bot",
    has_topics_enabled: true,
  });
  editMessageTextSpy.mockReset();
  editMessageTextSpy.mockResolvedValue({ message_id: 88 });
  editMessageReplyMarkupSpy.mockReset();
  editMessageReplyMarkupSpy.mockResolvedValue({ message_id: 88 });
  sendMessageDraftSpy.mockReset();
  sendMessageDraftSpy.mockResolvedValue(true);
  enqueueSystemEventSpy.mockReset();
  wasSentByBot.mockReset();
  wasSentByBot.mockReturnValue(false);
  listSkillCommandsForAgents.mockReset();
  listSkillCommandsForAgents.mockReturnValue([]);
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
