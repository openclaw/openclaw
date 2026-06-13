// Telegram tests cover that source-delivery records sent messages into the ledger.
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadWebMedia } = vi.hoisted(() => ({ loadWebMedia: vi.fn() }));
const recordSentMessage = vi.hoisted(() => vi.fn());
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSending: vi.fn(),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: () => messageHookRunner };
});

vi.mock("../sent-message-cache.js", () => ({
  recordSentMessage,
  wasSentByBot: vi.fn(() => false),
  clearSentMessageCache: vi.fn(),
}));

vi.mock("grammy", () => ({
  API_CONSTANTS: { DEFAULT_UPDATE_TYPES: ["message"], ALL_UPDATE_TYPES: ["message"] },
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

vi.resetModules();
const { deliverReplies } = await import("./delivery.js");

type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;
function createRuntime(): RuntimeStub {
  return { error: vi.fn(), log: vi.fn(), exit: vi.fn() };
}
function createBot(api: Record<string, unknown>): Bot {
  // Mirror the rich-message send path: sendTelegramText now goes through
  // bot.api.raw.sendRichMessage, which delegates to the provided sendMessage.
  const raw = {
    sendRichMessage: vi.fn(
      (params: {
        chat_id: string | number;
        rich_message: { markdown?: string; html?: string };
        [key: string]: unknown;
      }) => {
        const sendMessage = api.sendMessage;
        if (typeof sendMessage !== "function") {
          throw new Error("sendMessage mock missing");
        }
        const { chat_id, rich_message, ...richParams } = params;
        const text = rich_message.markdown ?? rich_message.html ?? "";
        return sendMessage(chat_id, text, { parse_mode: "HTML", ...richParams });
      },
    ),
  };
  return { api: { ...api, raw } } as unknown as Bot;
}
const cfg = { session: { scope: "global" } } as unknown as OpenClawConfig;

describe("deliverReplies sent-message ledger", () => {
  beforeEach(() => {
    recordSentMessage.mockClear();
  });

  it("records the sent message id on successful text delivery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 4242, chat: { id: "123" } });
    await deliverReplies({
      replies: [{ text: "hello" }],
      cfg,
      chatId: "123",
      token: "tok",
      runtime: createRuntime() as RuntimeEnv,
      bot: createBot({ sendMessage }),
      replyToMode: "off",
      textLimit: 4000,
      mediaLoader: loadWebMedia,
    });
    expect(recordSentMessage).toHaveBeenCalledWith("123", 4242, cfg);
  });

  it("does not record when nothing is delivered", async () => {
    await deliverReplies({
      replies: [{ text: "   " }],
      cfg,
      chatId: "123",
      token: "tok",
      runtime: createRuntime() as RuntimeEnv,
      bot: createBot({ sendMessage: vi.fn() }),
      replyToMode: "off",
      textLimit: 4000,
      mediaLoader: loadWebMedia,
    });
    expect(recordSentMessage).not.toHaveBeenCalled();
  });

  it("records every delivered message id when a reply is split into multiple sends", async () => {
    // The canonical send path records each Telegram message id; a single reply
    // can fan out into several sends (chunked text, multi-media, voice fallback),
    // so reactions / reply-routing against later messages must also see them.
    let nextId = 100;
    const sendMessage = vi
      .fn()
      .mockImplementation(async () => ({ message_id: ++nextId, chat: { id: "123" } }));
    await deliverReplies({
      replies: [{ text: "first paragraph here\n\nsecond paragraph here" }],
      cfg,
      chatId: "123",
      token: "tok",
      runtime: createRuntime() as RuntimeEnv,
      bot: createBot({ sendMessage }),
      replyToMode: "off",
      textLimit: 16,
      mediaLoader: loadWebMedia,
    });
    const sendCount = sendMessage.mock.calls.length;
    expect(sendCount).toBeGreaterThan(1);
    // Every delivered id is recorded, not just the first one.
    expect(recordSentMessage).toHaveBeenCalledTimes(sendCount);
    for (let id = 101; id <= 100 + sendCount; id += 1) {
      expect(recordSentMessage).toHaveBeenCalledWith("123", id, cfg);
    }
  });

  it("records every voice-fallback text id when the fallback chunks into multiple sends", async () => {
    // When sendVoice is forbidden, delivery falls back to text that can itself
    // chunk into multiple sends; each fallback message id must be recorded.
    let nextId = 200;
    const sendMessage = vi
      .fn()
      .mockImplementation(async () => ({ message_id: ++nextId, chat: { id: "123" } }));
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error("Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)"),
      );
    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio-bytes"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });
    await deliverReplies({
      replies: [
        {
          mediaUrl: "https://example.com/note.ogg",
          text: "first paragraph here\n\nsecond paragraph here",
          audioAsVoice: true,
        },
      ],
      cfg,
      chatId: "123",
      token: "tok",
      runtime: createRuntime() as RuntimeEnv,
      bot: createBot({ sendVoice, sendMessage }),
      replyToMode: "off",
      textLimit: 16,
      mediaLoader: loadWebMedia,
    });
    expect(sendVoice).toHaveBeenCalledTimes(1);
    const fallbackSends = sendMessage.mock.calls.length;
    expect(fallbackSends).toBeGreaterThan(1);
    expect(recordSentMessage).toHaveBeenCalledTimes(fallbackSends);
    for (let id = 201; id <= 200 + fallbackSends; id += 1) {
      expect(recordSentMessage).toHaveBeenCalledWith("123", id, cfg);
    }
  });
});
