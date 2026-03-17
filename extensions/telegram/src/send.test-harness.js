import { beforeEach, vi } from "vitest";
const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    deleteMessage: vi.fn(),
    editMessageText: vi.fn(),
    sendChatAction: vi.fn(),
    sendMessage: vi.fn(),
    sendPoll: vi.fn(),
    sendPhoto: vi.fn(),
    sendVoice: vi.fn(),
    sendAudio: vi.fn(),
    sendVideo: vi.fn(),
    sendVideoNote: vi.fn(),
    sendAnimation: vi.fn(),
    setMessageReaction: vi.fn(),
    sendSticker: vi.fn()
  },
  botCtorSpy: vi.fn()
}));
const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn()
}));
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}))
}));
const { maybePersistResolvedTelegramTarget } = vi.hoisted(() => ({
  maybePersistResolvedTelegramTarget: vi.fn(async () => {
  })
}));
vi.mock("../../whatsapp/src/media.js", () => ({
  loadWebMedia
}));
vi.mock("grammy", () => ({
  Bot: class {
    constructor(token, options) {
      this.token = token;
      this.options = options;
      this.api = botApi;
      this.catch = vi.fn();
      botCtorSpy(token, options);
    }
  },
  InputFile: class {
  }
}));
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig
  };
});
vi.mock("./target-writeback.js", () => ({
  maybePersistResolvedTelegramTarget
}));
function getTelegramSendTestMocks() {
  return { botApi, botCtorSpy, loadConfig, loadWebMedia, maybePersistResolvedTelegramTarget };
}
function installTelegramSendTestHooks() {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    loadWebMedia.mockReset();
    maybePersistResolvedTelegramTarget.mockReset();
    maybePersistResolvedTelegramTarget.mockResolvedValue(void 0);
    botCtorSpy.mockReset();
    for (const fn of Object.values(botApi)) {
      fn.mockReset();
    }
  });
}
async function importTelegramSendModule() {
  return await import("./send.js");
}
export {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks
};
