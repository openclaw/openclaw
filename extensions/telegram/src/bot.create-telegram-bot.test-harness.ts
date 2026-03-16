import { beforeEach, vi } from "vitest";
import { resetInboundDedupe } from "../../../src/auto-reply/reply/inbound-dedupe.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import type { GetReplyOptions, ReplyPayload } from "../../../src/auto-reply/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { MockFn } from "../../../src/test-utils/vitest-mock-fn.js";

type AnyMock = MockFn<(...args: unknown[]) => unknown>;
type AnyAsyncMock = MockFn<(...args: unknown[]) => Promise<unknown>>;

const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}.json`,
}));

const { loadWebMedia } = vi.hoisted((): { loadWebMedia: AnyMock } => ({
  loadWebMedia: vi.fn(),
}));

export function getLoadWebMediaMock(): AnyMock {
  return loadWebMedia;
}

vi.mock("../../whatsapp/src/media.js", () => ({
  loadWebMedia,
}));

const { loadConfig } = vi.hoisted((): { loadConfig: AnyMock } => ({
  loadConfig: vi.fn(() => ({})),
}));

export function getLoadConfigMock(): AnyMock {
  return loadConfig;
}
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

const { loadModelCatalog } = vi.hoisted((): { loadModelCatalog: AnyAsyncMock } => ({
  loadModelCatalog: vi.fn(async () => []),
}));

export function getLoadModelCatalogMock(): AnyAsyncMock {
  return loadModelCatalog;
}

vi.mock("../../../src/agents/model-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agents/model-catalog.js")>();
  return {
    ...actual,
    loadModelCatalog,
  };
});

vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: vi.fn((storePath) => storePath ?? sessionStorePath),
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

vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
}));

const skillCommandsHoisted = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));
export const listSkillCommandsForAgents = skillCommandsHoisted.listSkillCommandsForAgents;

vi.mock("../../../src/auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents,
}));

const systemEventsHoisted = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn(),
}));
export const enqueueSystemEventSpy: AnyMock = systemEventsHoisted.enqueueSystemEventSpy;

vi.mock("../../../src/infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventSpy,
}));

const sentMessageCacheHoisted = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
export const wasSentByBot = sentMessageCacheHoisted.wasSentByBot;

vi.mock("./sent-message-cache.js", () => ({
  wasSentByBot,
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

vi.mock("grammy", () => ({
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
  InputFile: class {},
}));

const sequentializeMiddleware = vi.fn();
export const sequentializeSpy: AnyMock = vi.fn(() => sequentializeMiddleware);
export let sequentializeKey: ((ctx: unknown) => string) | undefined;
vi.mock("@grammyjs/runner", () => ({
  sequentialize: (keyFn: (ctx: unknown) => string) => {
    sequentializeKey = keyFn;
    return sequentializeSpy();
  },
}));

export const throttlerSpy: AnyMock = vi.fn(() => "throttler");

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

export const replySpy: MockFn<
  (
    ctx: MsgContext,
    opts?: GetReplyOptions,
    configOverride?: OpenClawConfig,
  ) => Promise<ReplyPayload | ReplyPayload[] | undefined>
> = vi.fn(async (_ctx, opts) => {
  await opts?.onReplyStart?.();
  return undefined;
});

vi.mock("../../../src/auto-reply/reply.js", () => ({
  getReplyFromConfig: replySpy,
  __replySpy: replySpy,
}));

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
  loadModelCatalog.mockReset();
  loadModelCatalog.mockResolvedValue([]);
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
  sequentializeSpy.mockReset();
  botCtorSpy.mockReset();
  sequentializeKey = undefined;
});
