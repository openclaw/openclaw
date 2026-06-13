import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the underlying send so the test can drive sendTelegramText return values
// directly. The accounting fix lives in delivery.replies.ts and reply-threading.ts:
// when sendTelegramText resolves undefined for a silently-skipped chunk
// (Telegram rejects empty post-render text -- markdown that collapses to
// whitespace through the markdown-to-HTML and supported-tag pipeline, such
// as a half-closed code fence or a bulleted list with no item content,
// surfaces as `text must be non-empty` from the Bot API), the chunked reply
// loop must not advance progress counters, fire message_sent, mirror
// transcript, or hand a phantom message id to pin/threading.
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

function createBot(): Bot {
  return { api: {} } as unknown as Bot;
}

const baseDeliveryParams = {
  chatId: "123",
  token: "tok",
  replyToMode: "off",
  textLimit: 4000,
} as const;

describe("deliverReplies skipped-send accounting", () => {
  beforeEach(() => {
    sendTelegramText.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSending.mockReset();
    messageHookRunner.runMessageSent.mockReset();
  });

  it("treats every-chunk-skipped text reply as a no-op across hooks, mirror, and delivered flag", async () => {
    // Regression: sendTelegramText can resolve undefined when the pre-flight
    // trim short-circuits an empty-after-trim html payload (with plainText also
    // empty), or when Telegram rejects post-strip text with the empty-text 400
    // wording. Before the fix, the chunked reply loop still called
    // markDelivered and markReplyApplied for skipped chunks, advancing
    // deliveredCount and producing a phantom message_sent success with
    // messageId=undefined plus a transcript mirror entry for nothing.
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sent" || name === "message_sending",
    );
    sendTelegramText.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const transcriptMirror = vi.fn();

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: "<br>" }],
      runtime,
      bot: createBot(),
      transcriptMirror,
    });

    expect(sendTelegramText).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: false });
    expect(transcriptMirror).not.toHaveBeenCalled();
    // message_sent still fires for accounting visibility, but success=false and
    // no messageId so consumers can distinguish a skipped chunk from a real
    // Telegram send. The canonical hook context omits messageId when it is
    // undefined; the raw call args must not contain a stringified id.
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(1);
    const sentEvent = messageHookRunner.runMessageSent.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(sentEvent?.success).toBe(false);
    expect(sentEvent?.messageId).toBeUndefined();
  });

  it("does not pin a phantom message when the only chunk silently skips", async () => {
    // pinChatMessage must never be called with an undefined message id; the
    // accounting fix means firstDeliveredMessageId stays undefined and the
    // pin branch short-circuits.
    sendTelegramText.mockResolvedValue(undefined);

    const runtime = createRuntime();
    const pinChatMessage = vi.fn();
    const bot = { api: { pinChatMessage } } as unknown as Bot;

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: "<br>", delivery: { pin: true } }],
      runtime,
      bot,
    });

    expect(result).toEqual({ delivered: false });
    expect(pinChatMessage).not.toHaveBeenCalled();
  });

  it("counts only delivered chunks when a multi-reply batch mixes a real send and a skipped send", async () => {
    // Multi-reply: first reply delivers normally, second reply silently skips.
    // Transcript mirror gets exactly one entry, message_sent fires once with
    // success=true and once with success=false, and the overall delivered flag
    // is true because at least one chunk landed.
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sent" || name === "message_sending",
    );
    sendTelegramText.mockResolvedValueOnce(99).mockResolvedValueOnce(undefined);

    const runtime = createRuntime();
    const transcriptMirror = vi.fn();

    const result = await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: "hello" }, { text: "<br>" }],
      runtime,
      bot: createBot(),
      transcriptMirror,
    });

    expect(sendTelegramText).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ delivered: true });
    expect(transcriptMirror).toHaveBeenCalledTimes(1);
    expect(transcriptMirror).toHaveBeenCalledWith({ text: "hello", mediaUrls: undefined });
    expect(messageHookRunner.runMessageSent).toHaveBeenCalledTimes(2);
    // messageId is stringified by buildCanonicalSentMessageHookContext before
    // it reaches the hook payload; the delivered chunk gets "99", the skipped
    // chunk has no messageId field at all.
    const deliveredEvent = messageHookRunner.runMessageSent.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    const skippedEvent = messageHookRunner.runMessageSent.mock.calls.at(1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(deliveredEvent?.success).toBe(true);
    expect(deliveredEvent?.messageId).toBe("99");
    expect(skippedEvent?.success).toBe(false);
    expect(skippedEvent?.messageId).toBeUndefined();
  });
});
