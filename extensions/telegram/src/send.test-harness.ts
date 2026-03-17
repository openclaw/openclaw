import type { MockFn } from "openclaw/plugin-sdk/testing";
import { beforeEach, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    deleteMessage: vi.fn(),
    editForumTopic: vi.fn(),
    editMessageText: vi.fn(),
    editMessageReplyMarkup: vi.fn(),
    pinChatMessage: vi.fn(),
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
    sendSticker: vi.fn(),
    unpinChatMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

const { maybePersistResolvedTelegramTarget } = vi.hoisted(() => ({
  maybePersistResolvedTelegramTarget: vi.fn(async () => {}),
}));

type TelegramSendTestMocks = {
  botApi: Record<string, MockFn>;
  botCtorSpy: MockFn;
  loadConfig: MockFn;
  loadWebMedia: MockFn;
  maybePersistResolvedTelegramTarget: MockFn;
};

vi.mock("../../whatsapp/src/media.js", () => ({
  loadWebMedia,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: {
        client?: { fetch?: typeof fetch; timeoutSeconds?: number };
      },
    ) {
      botCtorSpy(token, options);
    }
  },
  HttpError: class HttpError extends Error {
    constructor(
      message = "HttpError",
      public error?: unknown,
    ) {
      super(message);
    }
  },
  InputFile: class {},
}));

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./target-writeback.js", () => ({
  maybePersistResolvedTelegramTarget,
}));

export function getTelegramSendTestMocks(): TelegramSendTestMocks {
  return { botApi, botCtorSpy, loadConfig, loadWebMedia, maybePersistResolvedTelegramTarget };
}

export function installTelegramSendTestHooks() {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    loadWebMedia.mockReset();
    maybePersistResolvedTelegramTarget.mockReset();
    maybePersistResolvedTelegramTarget.mockResolvedValue(undefined);
    botCtorSpy.mockReset();
    for (const fn of Object.values(botApi)) {
      fn.mockReset();
    }
  });
}

export async function importTelegramSendModule() {
  vi.resetModules();
  return await import("./send.js");
}
