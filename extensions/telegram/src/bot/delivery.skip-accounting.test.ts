// Telegram tests cover reply accounting when sendTelegramText silently skips.
import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

// sendTelegramText resolves undefined for silently-skipped sends (payloads that
// render to empty Telegram content with an empty plain fallback). The accounting
// contract lives above it: skipped chunks must not advance delivery counters,
// fire message_sent success, mirror transcripts, or hand out phantom message ids.
const sendTelegramText = vi.hoisted(() => vi.fn());
const sendTelegramWithThreadFallback = vi.hoisted(() => vi.fn());
const buildTelegramSendParams = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("./delivery.send.js", () => ({
  sendTelegramText,
  sendTelegramWithThreadFallback,
  buildTelegramSendParams,
}));

const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSending: vi.fn(),
  runMessageSent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
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

const { deliverReplies } = await import("./delivery.js");

type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

function createRuntime(): RuntimeStub {
  return {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
  };
}

const baseDeliveryParams = {
  chatId: "123",
  token: "tok",
  replyToMode: "off",
  textLimit: 4000,
} as const;

function sentEventAt(index: number): Record<string, unknown> | undefined {
  return messageHookRunner.runMessageSent.mock.calls.at(index)?.[0] as
    | Record<string, unknown>
    | undefined;
}

describe("deliverReplies skipped-send accounting", () => {
  beforeEach(() => {
    sendTelegramText.mockReset();
    sendTelegramWithThreadFallback.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSending.mockReset();
    messageHookRunner.runMessageSent.mockReset();
  });

  it("treats an all-skipped text reply as a no-op across hooks, mirror, and delivered flag", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendTelegramText.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const transcriptMirror = vi.fn();

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: "renders empty on Telegram" }],
      runtime,
      bot: { api: {} } as unknown as Bot,
      transcriptMirror,
    });

    expect(sendTelegramText).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: false });
    expect(transcriptMirror).not.toHaveBeenCalled();
    // message_sent still fires for visibility, but reports success=false with
    // no messageId so consumers can tell a skip from a real Telegram send.
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(1);
    expect(sentEventAt(0)?.success).toBe(false);
    expect(sentEventAt(0)?.messageId).toBeUndefined();
  });

  it("does not pin a phantom message when the only chunk silently skips", async () => {
    sendTelegramText.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const pinChatMessage = vi.fn();

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: "renders empty on Telegram", delivery: { pin: true } }],
      runtime,
      bot: { api: { pinChatMessage } } as unknown as Bot,
    });

    expect(result).toEqual({ delivered: false });
    expect(pinChatMessage).not.toHaveBeenCalled();
  });

  it("counts only delivered replies when a batch mixes a real send and a skipped send", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    sendTelegramText.mockResolvedValueOnce(99).mockResolvedValueOnce(undefined);

    const runtime = createRuntime();
    const transcriptMirror = vi.fn();

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: "hello" }, { text: "renders empty on Telegram" }],
      runtime,
      bot: { api: {} } as unknown as Bot,
      transcriptMirror,
    });

    expect(sendTelegramText).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ delivered: true });
    expect(transcriptMirror).toHaveBeenCalledTimes(1);
    expect(transcriptMirror).toHaveBeenCalledWith({ text: "hello", mediaUrls: undefined });
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(2);
    // The canonical hook context stringifies real message ids and omits the
    // field entirely for skipped sends.
    expect(sentEventAt(0)?.success).toBe(true);
    expect(sentEventAt(0)?.messageId).toBe("99");
    expect(sentEventAt(1)?.success).toBe(false);
    expect(sentEventAt(1)?.messageId).toBeUndefined();
  });

  it("does not mirror caption text when the caption-too-long fallback send skips", async () => {
    // Voice delivered, caption text skipped: the transcript must not record
    // reply.text as delivered content alongside the voice message.
    sendTelegramWithThreadFallback
      .mockRejectedValueOnce(new Error("400: Bad Request: message caption is too long"))
      .mockResolvedValueOnce({ message_id: 7 });
    sendTelegramText.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const transcriptMirror = vi.fn();
    const mediaLoader = vi.fn().mockResolvedValue({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "caption text", audioAsVoice: true },
      ],
      runtime,
      bot: { api: {} } as unknown as Bot,
      mediaLoader,
      transcriptMirror,
    });

    expect(result).toEqual({ delivered: true });
    expect(sendTelegramWithThreadFallback).toHaveBeenCalledTimes(2);
    expect(transcriptMirror).toHaveBeenCalledTimes(1);
    expect(transcriptMirror).toHaveBeenCalledWith({
      text: undefined,
      mediaUrls: ["https://example.com/note.ogg"],
    });
  });

  it("keeps a voice-forbidden reply undelivered when the text fallback skips every chunk", async () => {
    sendTelegramWithThreadFallback.mockRejectedValue(
      new Error("400: Bad Request: VOICE_MESSAGES_FORBIDDEN"),
    );
    sendTelegramText.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const transcriptMirror = vi.fn();
    const mediaLoader = vi.fn().mockResolvedValue({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "fallback text", audioAsVoice: true },
      ],
      runtime,
      bot: { api: {} } as unknown as Bot,
      mediaLoader,
      transcriptMirror,
    });

    expect(result).toEqual({ delivered: false });
    expect(transcriptMirror).not.toHaveBeenCalled();
  });
});
