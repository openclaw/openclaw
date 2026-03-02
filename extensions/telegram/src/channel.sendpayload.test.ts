import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({
    channel: {
      telegram: {
        sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "tg-msg-1" }),
        resolveTelegramToken: vi.fn().mockReturnValue({ token: "test-token" }),
      },
      text: {
        chunkMarkdownText: vi.fn((text: string, limit: number) => {
          // Actually split text into chunks at the limit boundary
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

import { telegramPlugin } from "./channel.js";

describe("telegramPlugin sendPayload", () => {
  const cfg = { channels: { telegram: {} } };
  const baseCtx = {
    cfg,
    to: "chat:123",
    text: "",
    accountId: "default",
    payload: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates text-only payload to sendText", async () => {
    const sendTextSpy = vi
      .spyOn(telegramPlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "telegram", messageId: "t-1" });

    const result = await telegramPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello world" },
    } as never);

    expect(sendTextSpy).toHaveBeenCalledOnce();
    expect(sendTextSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world" }));
    expect(result).toEqual({ channel: "telegram", messageId: "t-1" });
  });

  it("delegates single media URL to sendMedia with caption", async () => {
    const sendMediaSpy = vi
      .spyOn(telegramPlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "telegram", messageId: "m-1" });

    const result = await telegramPlugin.outbound!.sendPayload!({
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
    expect(result).toEqual({ channel: "telegram", messageId: "m-1" });
  });

  it("iterates multiple media URLs with caption on first only", async () => {
    const sendMediaSpy = vi
      .spyOn(telegramPlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "telegram", messageId: "m-last" });

    const result = await telegramPlugin.outbound!.sendPayload!({
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
    expect(result).toEqual({ channel: "telegram", messageId: "m-last" });
  });

  it("returns no-op result for empty payload", async () => {
    const result = await telegramPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as never);

    expect(result).toEqual({ channel: "telegram", messageId: "" });
  });

  it("chunks long text via markdown chunker", async () => {
    const sendTextSpy = vi
      .spyOn(telegramPlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "telegram", messageId: "chunk-last" });

    // Create text longer than the 4000-char limit
    const longText = "x".repeat(9000);

    const result = await telegramPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as never);

    // Should split into 3 chunks: 4000 + 4000 + 1000
    expect(sendTextSpy).toHaveBeenCalledTimes(3);
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "x".repeat(4000) }),
    );
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "x".repeat(4000) }),
    );
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ text: "x".repeat(1000) }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "chunk-last" });
  });
});
