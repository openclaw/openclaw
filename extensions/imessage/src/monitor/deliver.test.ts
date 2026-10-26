import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIMessageEchoCachingSend, deliverIMessageReply } from "./deliver.js";

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

// mock-isolation: Delivery fixtures supply native send receipts without invoking the iMessage client.
vi.mock("../send.js", () => ({
  sendMessageIMessage: sendMessageIMessageMock,
}));

vi.mock("openclaw/plugin-sdk/reply-chunking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-chunking")>()),
  chunkMarkdownTextWithMode: (text: string) => chunkTextWithModeMock(text),
  resolveChunkMode: vi.fn(() => "length"),
}));

describe("deliverIMessageReply", () => {
  const cfg = { channels: { imessage: { accounts: { default: {} } } } };
  const runtime = { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
  const remember = vi.fn();
  const destination = { target: "chat_id:20", accountId: "acct-2" };
  const defaults = { cfg, runtime, textLimit: 4000, maxBytes: 2048, ...destination };
  const deliver = (
    payload: Parameters<typeof deliverIMessageReply>[0]["payload"],
    options: Partial<Parameters<typeof deliverIMessageReply>[0]> = {},
  ) => deliverIMessageReply({ ...defaults, payload, ...options });

  beforeEach(() => {
    vi.clearAllMocks();
    chunkTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  it("forwards voice-note payloads to the canonical iMessage media sender", async () => {
    const mediaUrl = "https://example.com/voice.caf";
    const media = { contentType: "audio/x-caf", kind: "audio" };
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-media-1",
      sentText: "",
      echoMedia: media,
      receipt: createTestIMessageReceipt("imsg-media-1", "media"),
    });
    await deliver(
      { mediaUrl, audioAsVoice: true },
      { maxBytes: 8192, sentMessageCache: { remember } },
    );

    expect(sendMessageIMessageMock).toHaveBeenCalledWith(
      "chat_id:20",
      "",
      expect.objectContaining({ accountId: "acct-2", audioAsVoice: true, mediaUrl }),
    );
    expect(remember).toHaveBeenCalledWith("acct-2:chat_id:20", {
      media,
      messageId: "imsg-media-1",
    });
  });

  it("sanitizes durable outbound text before sending", async () => {
    const send = createIMessageEchoCachingSend({
      accountId: "acct-6",
      sentMessageCache: { remember },
    });
    sendMessageIMessageMock.mockResolvedValueOnce(sentText("sent-2", "reply"));

    await send("chat_id:60", "<thinking>hidden</thinking>\nreply\nassistant:", {
      config: cfg,
      accountId: "other",
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledExactlyOnceWith(
      "chat_id:60",
      "reply",
      expect.objectContaining({ accountId: "other" }),
    );
    expect(remember).toHaveBeenCalledWith("acct-6:chat_id:60", {
      text: "reply",
      messageId: "sent-2",
    });
  });

  it("records outbound text and message ids in sent-message cache after send", async () => {
    // #47830: cache sent chunks, never the full pre-send text.
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));
    sendMessageIMessageMock
      .mockResolvedValueOnce(sentText("imsg-1", "first"))
      .mockResolvedValueOnce(sentText("imsg-2", "second"));

    await deliver({ text: "first|second" }, { sentMessageCache: { remember } });

    expect(remember.mock.calls).toStrictEqual([
      ["acct-2:chat_id:20", { text: "first", messageId: "imsg-1" }],
      ["acct-2:chat_id:20", { text: "second", messageId: "imsg-2" }],
    ]);
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

    const observed: unknown = await deliver(
      {
        text: "visible caption",
        mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
        replyToId: "unsupported-thread",
      },
      { maxBytes: 4096 },
    ).catch((error: unknown) => error);

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
});
