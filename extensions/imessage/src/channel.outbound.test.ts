import { describe, expect, it, vi } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { imessagePlugin } from "./channel.js";
import type { IMessageRpcClient } from "./client.js";
import { imessageOutbound } from "./outbound-adapter.js";
import { sendMessageIMessage } from "./send.js";

function requireIMessageSendText() {
  const sendText = imessagePlugin.outbound?.sendText;
  if (!sendText) {
    throw new Error("imessage outbound.sendText unavailable");
  }
  return sendText;
}

function requireIMessageSendMedia() {
  const sendMedia = imessagePlugin.outbound?.sendMedia;
  if (!sendMedia) {
    throw new Error("imessage outbound.sendMedia unavailable");
  }
  return sendMedia;
}

function requireIMessageChunker() {
  const chunker = imessagePlugin.outbound?.chunker;
  if (!chunker) {
    throw new Error("imessage outbound.chunker unavailable");
  }
  return chunker;
}

const requestMock = vi.fn();
const stopMock = vi.fn();

const defaultAccount: ResolvedIMessageAccount = {
  accountId: "default",
  enabled: true,
  configured: false,
  config: {},
};

function createClient(): IMessageRpcClient {
  return {
    request: (...args: unknown[]) => requestMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
  } as unknown as IMessageRpcClient;
}

async function sendWithDefaults(
  to: string,
  text: string,
  opts: Parameters<typeof sendMessageIMessage>[2] = {},
) {
  return await sendMessageIMessage(to, text, {
    account: defaultAccount,
    config: {},
    client: createClient(),
    ...opts,
  });
}

function getSentParams() {
  return requestMock.mock.calls[0]?.[1] as Record<string, unknown>;
}

async function expectDirectOutboundResult(params: {
  invoke: () => Promise<{ channel: string; messageId: string }>;
  sendIMessage: ReturnType<typeof vi.fn>;
  to: string;
  text: string;
  expectedOptions: Record<string, unknown>;
  expectedResult: { channel: string; messageId: string };
}) {
  const result = await params.invoke();
  expect(params.sendIMessage).toHaveBeenCalledWith(
    params.to,
    params.text,
    expect.objectContaining(params.expectedOptions),
  );
  expect(result).toEqual(params.expectedResult);
}

async function expectReplyToTextForwarding(params: {
  invoke: () => Promise<{ channel: string; messageId: string }>;
  sendIMessage: ReturnType<typeof vi.fn>;
}) {
  await expectDirectOutboundResult({
    invoke: params.invoke,
    sendIMessage: params.sendIMessage,
    to: "chat_id:12",
    text: "hello",
    expectedOptions: {
      accountId: "default",
      replyToId: "reply-1",
      maxBytes: 3 * 1024 * 1024,
    },
    expectedResult: { channel: "imessage", messageId: "m-text" },
  });
}

async function expectMediaLocalRootsForwarding(params: {
  invoke: () => Promise<{ channel: string; messageId: string }>;
  sendIMessage: ReturnType<typeof vi.fn>;
}) {
  await expectDirectOutboundResult({
    invoke: params.invoke,
    sendIMessage: params.sendIMessage,
    to: "chat_id:88",
    text: "caption",
    expectedOptions: {
      mediaUrl: "/tmp/workspace/pic.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "acct-1",
      replyToId: "reply-2",
      maxBytes: 3 * 1024 * 1024,
    },
    expectedResult: { channel: "imessage", messageId: "m-media-local" },
  });
}

describe("imessagePlugin outbound", () => {
  const cfg = {
    channels: {
      imessage: {
        mediaMaxMb: 3,
      },
    },
  };

  it("forwards replyToId on direct sendText adapter path", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = requireIMessageSendText();

    await expectReplyToTextForwarding({
      invoke: async () =>
        await sendText({
          cfg,
          to: "chat_id:12",
          text: "hello",
          accountId: "default",
          replyToId: "reply-1",
          deps: { sendIMessage },
        }),
      sendIMessage,
    });
  });

  it("forwards replyToId on direct sendMedia adapter path", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = requireIMessageSendMedia();

    const result = await sendMedia({
      cfg,
      to: "chat_id:77",
      text: "caption",
      mediaUrl: "https://example.com/pic.png",
      accountId: "acct-1",
      replyToId: "reply-2",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:77",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/pic.png",
        accountId: "acct-1",
        replyToId: "reply-2",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-media" });
  });

  it("forwards mediaLocalRoots on direct sendMedia adapter path", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m-media-local" });
    const sendMedia = requireIMessageSendMedia();
    const mediaLocalRoots = ["/tmp/workspace"];

    await expectMediaLocalRootsForwarding({
      invoke: async () =>
        await sendMedia({
          cfg,
          to: "chat_id:88",
          text: "caption",
          mediaUrl: "/tmp/workspace/pic.png",
          mediaLocalRoots,
          accountId: "acct-1",
          replyToId: "reply-2",
          deps: { sendIMessage },
        }),
      sendIMessage,
    });
  });

  it("chunks outbound text without requiring iMessage runtime initialization", () => {
    const chunker = requireIMessageChunker();

    expect(() => chunker("hello world", 5)).not.toThrow();
    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });
});

describe("imessageOutbound", () => {
  const cfg = {
    channels: {
      imessage: {
        mediaMaxMb: 3,
      },
    },
  };

  it("forwards replyToId on direct text sends", async () => {
    const sendIMessage = vi.fn().mockResolvedValueOnce({ messageId: "m-text" });

    await expectReplyToTextForwarding({
      invoke: async () =>
        await imessageOutbound.sendText!({
          cfg,
          to: "chat_id:12",
          text: "hello",
          accountId: "default",
          replyToId: "reply-1",
          deps: { sendIMessage },
        }),
      sendIMessage,
    });
  });

  it("forwards mediaLocalRoots on direct media sends", async () => {
    const sendIMessage = vi.fn().mockResolvedValueOnce({ messageId: "m-media-local" });

    await expectMediaLocalRootsForwarding({
      invoke: async () =>
        await imessageOutbound.sendMedia!({
          cfg,
          to: "chat_id:88",
          text: "caption",
          mediaUrl: "/tmp/workspace/pic.png",
          mediaLocalRoots: ["/tmp/workspace"],
          accountId: "acct-1",
          replyToId: "reply-2",
          deps: { sendIMessage },
        }),
      sendIMessage,
    });
  });
});

describe("sendMessageIMessage", () => {
  it("sends to chat_id targets", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hi");
    const params = getSentParams();
    expect(requestMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    expect(params.chat_id).toBe(123);
    expect(params.text).toBe("hi");
  });

  it("applies sms service prefix", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("sms:+1555", "hello");
    const params = getSentParams();
    expect(params.service).toBe("sms");
    expect(params.to).toBe("+1555");
  });

  it("adds file attachment with placeholder text", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:7", "", {
      mediaUrl: "http://x/y.jpg",
      resolveAttachmentImpl: async () => ({
        path: "/tmp/imessage-media.jpg",
        contentType: "image/jpeg",
      }),
    });
    const params = getSentParams();
    expect(params.file).toBe("/tmp/imessage-media.jpg");
    expect(params.text).toBe("<media:image>");
  });

  it("normalizes mixed-case parameterized MIME for attachment placeholder text", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:7", "", {
      mediaUrl: "http://x/voice",
      resolveAttachmentImpl: async () => ({
        path: "/tmp/imessage-media.ogg",
        contentType: " Audio/Ogg; codecs=opus ",
      }),
    });
    const params = getSentParams();
    expect(params.file).toBe("/tmp/imessage-media.ogg");
    expect(params.text).toBe("<media:audio>");
  });

  it("returns message id when rpc provides one", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true, id: 123 });
    stopMock.mockClear().mockResolvedValue(undefined);

    const result = await sendWithDefaults("chat_id:7", "hello");
    expect(result.messageId).toBe("123");
  });

  it("passes replyToId as separate reply_to param instead of embedding in text", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello world", {
      replyToId: "abc-123",
    });
    const params = getSentParams();
    expect(params.text).toBe("hello world");
    expect(params.reply_to).toBe("abc-123");
  });

  it("strips inline reply tags from text and passes replyToId as reply_to param", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", " [[reply_to:old-id]] hello", {
      replyToId: "new-id",
    });
    const params = getSentParams();
    expect(params.text).toBe("hello");
    expect(params.reply_to).toBe("new-id");
  });

  it("sanitizes replyToId before passing as reply_to param", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello", {
      replyToId: " [ab]\n\u0000c\td ] ",
    });
    const params = getSentParams();
    expect(params.text).toBe("hello");
    expect(params.reply_to).toBe("abcd");
  });

  it("omits reply_to param when sanitized replyToId is empty", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello", {
      replyToId: "[]\u0000\n\r",
    });
    const params = getSentParams();
    expect(params.text).toBe("hello");
    expect(params.reply_to).toBeUndefined();
  });

  it("strips stray [[reply_to:...]] tags from text even without replyToId option", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "[[reply_to:65]] Great question");
    const params = getSentParams();
    expect(params.text).toBe("Great question");
    expect(params.reply_to).toBeUndefined();
  });

  it("strips [[audio_as_voice]] tags from outbound text", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello [[audio_as_voice]] world");
    const params = getSentParams();
    expect(params.text).toBe("hello world");
  });

  it("throws when text is only directive tags and no media", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await expect(sendWithDefaults("chat_id:123", "[[reply_to:65]]")).rejects.toThrow(
      "iMessage send requires text or media",
    );
  });

  it("normalizes string message_id values from rpc result", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true, message_id: "  guid-1  " });
    stopMock.mockClear().mockResolvedValue(undefined);

    const result = await sendWithDefaults("chat_id:7", "hello");
    expect(result.messageId).toBe("guid-1");
  });

  it("does not stop an injected client", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello");
    expect(stopMock).not.toHaveBeenCalled();
  });
});
