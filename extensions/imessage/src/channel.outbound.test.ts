import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getIMessageRuntime: () => ({
    channel: {
      imessage: {
        sendMessageIMessage: vi.fn().mockResolvedValue({ messageId: "im-msg-1" }),
      },
      text: {
        chunkText: vi.fn((text: string, limit: number) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks.length > 0 ? chunks : [text];
        }),
      },
    },
  }),
}));

import { imessagePlugin } from "./channel.js";

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
    const sendText = imessagePlugin.outbound?.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
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
    const sendMedia = imessagePlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
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
    const sendMedia = imessagePlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await sendMedia!({
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

describe("imessagePlugin sendPayload", () => {
  const cfg = {
    channels: {
      imessage: {
        mediaMaxMb: 3,
      },
    },
  };
  const baseCtx = {
    cfg,
    to: "chat_id:12",
    text: "",
    accountId: "default",
    payload: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates text-only payload to sendText", async () => {
    const sendTextSpy = vi
      .spyOn(imessagePlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "imessage", messageId: "i-1" });

    const result = await imessagePlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello imessage" },
    } as never);

    expect(sendTextSpy).toHaveBeenCalledOnce();
    expect(sendTextSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "hello imessage" }));
    expect(result).toEqual({ channel: "imessage", messageId: "i-1" });
  });

  it("delegates single media URL to sendMedia with caption", async () => {
    const sendMediaSpy = vi
      .spyOn(imessagePlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "imessage", messageId: "im-1" });

    const result = await imessagePlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://example.com/pic.png" },
    } as never);

    expect(sendMediaSpy).toHaveBeenCalledOnce();
    expect(sendMediaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption",
        mediaUrl: "https://example.com/pic.png",
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "im-1" });
  });

  it("iterates multiple media URLs with caption on first only", async () => {
    const sendMediaSpy = vi
      .spyOn(imessagePlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "imessage", messageId: "im-last" });

    const result = await imessagePlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {
        text: "cap",
        mediaUrls: [
          "https://example.com/a.png",
          "https://example.com/b.png",
          "https://example.com/c.png",
        ],
      },
    } as never);

    expect(sendMediaSpy).toHaveBeenCalledTimes(3);
    expect(sendMediaSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "cap", mediaUrl: "https://example.com/a.png" }),
    );
    expect(sendMediaSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "", mediaUrl: "https://example.com/b.png" }),
    );
    expect(sendMediaSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ text: "", mediaUrl: "https://example.com/c.png" }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "im-last" });
  });

  it("returns no-op result for empty payload", async () => {
    const result = await imessagePlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as never);

    expect(result).toEqual({ channel: "imessage", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    // Simulate a chunker that strips whitespace-only input to nothing
    vi.spyOn(imessagePlugin.outbound!, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(imessagePlugin.outbound!, "sendText");

    const result = await imessagePlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);

    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "imessage", messageId: "" });
  });

  it("chunks long text via text chunker", async () => {
    const sendTextSpy = vi
      .spyOn(imessagePlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "imessage", messageId: "chunk-last" });

    const longText = "a".repeat(9000);

    const result = await imessagePlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as never);

    expect(sendTextSpy).toHaveBeenCalledTimes(3);
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "a".repeat(4000) }),
    );
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "a".repeat(4000) }),
    );
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ text: "a".repeat(1000) }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "chunk-last" });
  });
});
