import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageIMessageMock = vi.hoisted(() =>
  vi.fn().mockImplementation(async (_to: string, message: string) => sentText("imsg-1", message)),
);
const chunkTextWithModeMock = vi.hoisted(() => vi.fn((text: string) => [text]));

function createTestIMessageReceipt(ids: string | string[], kind: "text" | "media" = "text") {
  return createMessageReceiptFromOutboundResults({
    results: (typeof ids === "string" ? [ids] : ids).map((messageId) => ({
      channel: "imessage",
      messageId,
    })),
    kind,
  });
}

function sentText(messageId: string, text: string) {
  return { messageId, sentText: text, receipt: createTestIMessageReceipt(messageId) };
}

vi.mock("../send.js", () => ({
  sendMessageIMessage: (to: string, message: string, opts?: unknown) =>
    sendMessageIMessageMock(to, message, opts),
}));

vi.mock("openclaw/plugin-sdk/reply-chunking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-chunking")>()),
  chunkMarkdownTextWithMode: (text: string) => chunkTextWithModeMock(text),
  resolveChunkMode: vi.fn(() => "length"),
}));

let deliverIMessageReply: typeof import("./deliver.js").deliverIMessageReply;
let createIMessageEchoCachingSend: typeof import("./deliver.js").createIMessageEchoCachingSend;

describe("deliverIMessageReply", () => {
  const cfg = { channels: { imessage: { accounts: { default: {} } } } };
  const runtime = { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
  const remember = vi.fn();
  const destination = { target: "chat_id:20", accountId: "acct-2" };
  const deliveryDefaults = { cfg, runtime, textLimit: 4000, maxBytes: 2048, ...destination };

  beforeAll(async () => {
    ({ createIMessageEchoCachingSend, deliverIMessageReply } = await import("./deliver.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    chunkTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  afterAll(() => {
    vi.doUnmock("../send.js");
    vi.doUnmock("openclaw/plugin-sdk/reply-chunking");
    vi.resetModules();
  });

  it("forwards voice-note payloads to the canonical iMessage media sender", async () => {
    await deliverIMessageReply({
      ...deliveryDefaults,
      payload: { mediaUrl: "https://example.com/voice.caf", audioAsVoice: true },
      maxBytes: 8192,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledWith(
      "chat_id:20",
      "",
      expect.objectContaining({
        accountId: "acct-2",
        audioAsVoice: true,
        mediaUrl: "https://example.com/voice.caf",
      }),
    );
  });

  it("sanitizes durable outbound text before sending", async () => {
    const send = createIMessageEchoCachingSend({
      accountId: "acct-6",
      sentMessageCache: { remember },
    });
    sendMessageIMessageMock.mockResolvedValueOnce(sentText("imsg-durable-2", "Visible reply"));

    await send("chat_id:60", "<thinking>hidden</thinking>\nVisible reply\nassistant:", {
      config: cfg,
      accountId: "acct-ignored",
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledExactlyOnceWith(
      "chat_id:60",
      "Visible reply",
      expect.objectContaining({
        config: cfg,
        accountId: "acct-ignored",
      }),
    );
    expect(remember).toHaveBeenCalledWith("acct-6:chat_id:60", {
      text: "Visible reply",
      messageId: "imsg-durable-2",
    });
  });

  it("records outbound text and message ids in sent-message cache after send", async () => {
    // #47830: cache sent chunks, never the full pre-send text.
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));
    sendMessageIMessageMock
      .mockResolvedValueOnce(sentText("imsg-1", "first"))
      .mockResolvedValueOnce(sentText("imsg-2", "second"));

    await deliverIMessageReply({
      ...deliveryDefaults,
      payload: { text: "first|second" },
      sentMessageCache: { remember },
    });

    expect(remember.mock.calls).toStrictEqual([
      ["acct-2:chat_id:20", { text: "first", messageId: "imsg-1" }],
      ["acct-2:chat_id:20", { text: "second", messageId: "imsg-2" }],
    ]);
  });

  it("records the internal echo key for media-only replies", async () => {
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-media-1",
      sentText: "",
      echoMedia: { contentType: "image/jpeg", kind: "image" },
      receipt: createTestIMessageReceipt("imsg-media-1", "media"),
    });

    await deliverIMessageReply({
      ...deliveryDefaults,
      payload: { mediaUrls: ["https://example.com/a.jpg"] },
      sentMessageCache: { remember },
    });

    expect(remember).toHaveBeenCalledWith("acct-2:chat_id:20", {
      media: { contentType: "image/jpeg", kind: "image" },
      messageId: "imsg-media-1",
    });
  });

  it("preserves earlier media receipts when a later native caption fails", async () => {
    const firstReceipt = createTestIMessageReceipt(["first-attachment", "first-caption"], "media");
    sendMessageIMessageMock
      .mockResolvedValueOnce({
        messageId: "first-attachment",
        sentText: "visible caption",
        receipt: firstReceipt,
      })
      .mockRejectedValueOnce(
        createChannelPartialDeliveryError(new Error("caption rejected"), {
          messageIds: ["second-attachment"],
          receipt: createTestIMessageReceipt("second-attachment", "media"),
          visibleReplySent: true,
          content: "",
        }),
      );

    const observed: unknown = await deliverIMessageReply({
      ...deliveryDefaults,
      payload: {
        text: "visible caption",
        mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
        replyToId: "unsupported-thread",
      },
      maxBytes: 4096,
    }).catch((error: unknown) => error);

    if (!isChannelPartialDeliveryError(observed)) {
      throw new Error("expected canonical partial delivery error");
    }
    expect(observed.deliveryResult).toMatchObject({
      visibleReplySent: true,
      messageIds: ["first-attachment", "first-caption", "second-attachment"],
      content: "visible caption",
      receipt: {
        platformMessageIds: ["first-attachment", "first-caption", "second-attachment"],
      },
    });
    expect(observed.deliveryResult.receipt).not.toHaveProperty("replyToId");
  });

  it("returns a recorded non-visible outcome when sanitization removes the complete reply", async () => {
    const delivered = await deliverIMessageReply({
      ...deliveryDefaults,
      payload: { text: "<thinking>private reasoning</thinking>" },
      maxBytes: 4096,
    });

    expect(sendMessageIMessageMock).not.toHaveBeenCalled();
    expect(delivered).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });
});
