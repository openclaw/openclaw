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

    const result = await sendText({
      cfg,
      to: "chat_id:12",
      text: "hello",
      accountId: "default",
      replyToId: "reply-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:12",
      "hello",
      expect.objectContaining({
        accountId: "default",
        replyToId: "reply-1",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-text" });
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

    const result = await sendMedia({
      cfg,
      to: "chat_id:88",
      text: "caption",
      mediaUrl: "/tmp/workspace/pic.png",
      mediaLocalRoots,
      accountId: "acct-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:88",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/pic.png",
        mediaLocalRoots,
        accountId: "acct-1",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-media-local" });
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

    const result = await imessageOutbound.sendText!({
      cfg,
      to: "chat_id:12",
      text: "hello",
      accountId: "default",
      replyToId: "reply-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:12",
      "hello",
      expect.objectContaining({
        accountId: "default",
        replyToId: "reply-1",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-text" });
  });

  it("forwards mediaLocalRoots on direct media sends", async () => {
    const sendIMessage = vi.fn().mockResolvedValueOnce({ messageId: "m-media-local" });

    const result = await imessageOutbound.sendMedia!({
      cfg,
      to: "chat_id:88",
      text: "caption",
      mediaUrl: "/tmp/workspace/pic.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "acct-1",
      replyToId: "reply-2",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:88",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/pic.png",
        mediaLocalRoots: ["/tmp/workspace"],
        accountId: "acct-1",
        replyToId: "reply-2",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-media-local" });
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

  it("prepends reply tag as the first token when replyToId is provided", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "  hello\nworld", {
      replyToId: "abc-123",
    });
    const params = getSentParams();
    expect(params.text).toBe("[[reply_to:abc-123]] hello\nworld");
  });

  it("rewrites an existing leading reply tag to keep the requested id first", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", " [[reply_to:old-id]] hello", {
      replyToId: "new-id",
    });
    const params = getSentParams();
    expect(params.text).toBe("[[reply_to:new-id]] hello");
  });

  it("sanitizes replyToId before writing the leading reply tag", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello", {
      replyToId: " [ab]\n\u0000c\td ] ",
    });
    const params = getSentParams();
    expect(params.text).toBe("[[reply_to:abcd]] hello");
  });

  it("skips reply tagging when sanitized replyToId is empty", async () => {
    requestMock.mockClear().mockResolvedValue({ ok: true });
    stopMock.mockClear().mockResolvedValue(undefined);

    await sendWithDefaults("chat_id:123", "hello", {
      replyToId: "[]\u0000\n\r",
    });
    const params = getSentParams();
    expect(params.text).toBe("hello");
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
