import { beforeEach, vi } from "vitest";
import { resetInboundDedupe } from "../../../src/auto-reply/reply/inbound-dedupe.js";
const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}.json`
}));
const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn()
}));
function getLoadWebMediaMock() {
  return loadWebMedia;
}
vi.mock("../../whatsapp/src/media.js", () => ({
  loadWebMedia
}));
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}))
}));
function getLoadConfigMock() {
  return loadConfig;
}
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig
  };
});
vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveStorePath: vi.fn((storePath) => storePath ?? sessionStorePath)
  };
});
const { readChannelAllowFromStore, upsertChannelPairingRequest } = vi.hoisted(
  () => ({
    readChannelAllowFromStore: vi.fn(async () => []),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true
    }))
  })
);
function getReadChannelAllowFromStoreMock() {
  return readChannelAllowFromStore;
}
function getUpsertChannelPairingRequestMock() {
  return upsertChannelPairingRequest;
}
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore,
  upsertChannelPairingRequest
}));
const skillCommandsHoisted = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => [])
}));
const listSkillCommandsForAgents = skillCommandsHoisted.listSkillCommandsForAgents;
vi.mock("../../../src/auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents
}));
const systemEventsHoisted = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn()
}));
const enqueueSystemEventSpy = systemEventsHoisted.enqueueSystemEventSpy;
vi.mock("../../../src/infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventSpy
}));
const sentMessageCacheHoisted = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false)
}));
const wasSentByBot = sentMessageCacheHoisted.wasSentByBot;
vi.mock("./sent-message-cache.js", () => ({
  wasSentByBot,
  recordSentMessage: vi.fn(),
  clearSentMessageCache: vi.fn()
}));
const grammySpies = vi.hoisted(() => ({
  useSpy: vi.fn(),
  middlewareUseSpy: vi.fn(),
  onSpy: vi.fn(),
  stopSpy: vi.fn(),
  commandSpy: vi.fn(),
  botCtorSpy: vi.fn(),
  answerCallbackQuerySpy: vi.fn(async () => void 0),
  sendChatActionSpy: vi.fn(),
  editMessageTextSpy: vi.fn(async () => ({ message_id: 88 })),
  editMessageReplyMarkupSpy: vi.fn(async () => ({ message_id: 88 })),
  sendMessageDraftSpy: vi.fn(async () => true),
  setMessageReactionSpy: vi.fn(async () => void 0),
  setMyCommandsSpy: vi.fn(async () => void 0),
  getMeSpy: vi.fn(async () => ({
    username: "openclaw_bot",
    has_topics_enabled: true
  })),
  sendMessageSpy: vi.fn(async () => ({ message_id: 77 })),
  sendAnimationSpy: vi.fn(async () => ({ message_id: 78 })),
  sendPhotoSpy: vi.fn(async () => ({ message_id: 79 })),
  getFileSpy: vi.fn(async () => ({ file_path: "media/file.jpg" }))
}));
const {
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
  getFileSpy
} = grammySpies;
vi.mock("grammy", () => ({
  Bot: class {
    constructor(token, options) {
      this.token = token;
      this.options = options;
      this.api = {
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
        getFile: grammySpies.getFileSpy
      };
      this.use = grammySpies.middlewareUseSpy;
      this.on = grammySpies.onSpy;
      this.stop = grammySpies.stopSpy;
      this.command = grammySpies.commandSpy;
      this.catch = vi.fn();
      grammySpies.botCtorSpy(token, options);
    }
  },
  InputFile: class {
  }
}));
const sequentializeMiddleware = vi.fn();
const sequentializeSpy = vi.fn(() => sequentializeMiddleware);
let sequentializeKey;
vi.mock("@grammyjs/runner", () => ({
  sequentialize: (keyFn) => {
    sequentializeKey = keyFn;
    return sequentializeSpy();
  }
}));
const throttlerSpy = vi.fn(() => "throttler");
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy()
}));
const replySpy = vi.fn(async (_ctx, opts) => {
  await opts?.onReplyStart?.();
  return void 0;
});
vi.mock("../../../src/auto-reply/reply.js", () => ({
  getReplyFromConfig: replySpy,
  __replySpy: replySpy
}));
const getOnHandler = (event) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) {
    throw new Error(`Missing handler for event: ${event}`);
  }
  return handler;
};
const DEFAULT_TELEGRAM_TEST_CONFIG = {
  agents: {
    defaults: {
      envelopeTimezone: "utc"
    }
  },
  channels: {
    telegram: { dmPolicy: "open", allowFrom: ["*"] }
  }
};
function makeTelegramMessageCtx(params) {
  return {
    message: {
      chat: params.chat,
      from: params.from,
      text: params.text,
      date: params.date ?? 1736380800,
      message_id: params.messageId ?? 42,
      ...params.messageThreadId === void 0 ? {} : { message_thread_id: params.messageThreadId }
    },
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() })
  };
}
function makeForumGroupMessageCtx(params) {
  return makeTelegramMessageCtx({
    chat: {
      id: params?.chatId ?? -1001234567890,
      type: "supergroup",
      title: params?.title ?? "Forum Group",
      is_forum: true
    },
    from: { id: params?.fromId ?? 12345, username: params?.username ?? "testuser" },
    text: params?.text ?? "hello",
    messageThreadId: params?.threadId
  });
}
beforeEach(() => {
  resetInboundDedupe();
  loadConfig.mockReset();
  loadConfig.mockReturnValue(DEFAULT_TELEGRAM_TEST_CONFIG);
  loadWebMedia.mockReset();
  readChannelAllowFromStore.mockReset();
  readChannelAllowFromStore.mockResolvedValue([]);
  upsertChannelPairingRequest.mockReset();
  upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRCODE", created: true });
  onSpy.mockReset();
  commandSpy.mockReset();
  stopSpy.mockReset();
  useSpy.mockReset();
  replySpy.mockReset();
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return void 0;
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
  setMessageReactionSpy.mockResolvedValue(void 0);
  answerCallbackQuerySpy.mockReset();
  answerCallbackQuerySpy.mockResolvedValue(void 0);
  sendChatActionSpy.mockReset();
  sendChatActionSpy.mockResolvedValue(void 0);
  setMyCommandsSpy.mockReset();
  setMyCommandsSpy.mockResolvedValue(void 0);
  getMeSpy.mockReset();
  getMeSpy.mockResolvedValue({
    username: "openclaw_bot",
    has_topics_enabled: true
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
  sequentializeKey = void 0;
});
export {
  answerCallbackQuerySpy,
  botCtorSpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getLoadConfigMock,
  getLoadWebMediaMock,
  getMeSpy,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  listSkillCommandsForAgents,
  makeForumGroupMessageCtx,
  makeTelegramMessageCtx,
  middlewareUseSpy,
  onSpy,
  replySpy,
  sendAnimationSpy,
  sendChatActionSpy,
  sendMessageDraftSpy,
  sendMessageSpy,
  sendPhotoSpy,
  sequentializeKey,
  sequentializeSpy,
  setMessageReactionSpy,
  setMyCommandsSpy,
  stopSpy,
  throttlerSpy,
  useSpy,
  wasSentByBot
};
