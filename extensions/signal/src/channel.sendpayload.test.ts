import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getSignalRuntime: () => ({
    channel: {
      signal: {
        sendMessageSignal: vi.fn().mockResolvedValue({ messageId: "sig-msg-1" }),
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

import { signalPlugin } from "./channel.js";

describe("signalPlugin sendPayload", () => {
  const cfg = { channels: { signal: {} } };
  const baseCtx = {
    cfg,
    to: "+15551234567",
    text: "",
    accountId: "default",
    payload: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates text-only payload to sendText", async () => {
    const sendTextSpy = vi
      .spyOn(signalPlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "signal", messageId: "s-1" });

    const result = await signalPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello signal" },
    } as never);

    expect(sendTextSpy).toHaveBeenCalledOnce();
    expect(sendTextSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "hello signal" }));
    expect(result).toEqual({ channel: "signal", messageId: "s-1" });
  });

  it("delegates single media URL to sendMedia with caption", async () => {
    const sendMediaSpy = vi
      .spyOn(signalPlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "signal", messageId: "sm-1" });

    const result = await signalPlugin.outbound!.sendPayload!({
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
    expect(result).toEqual({ channel: "signal", messageId: "sm-1" });
  });

  it("iterates multiple media URLs with caption on first only", async () => {
    const sendMediaSpy = vi
      .spyOn(signalPlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "signal", messageId: "sm-last" });

    const result = await signalPlugin.outbound!.sendPayload!({
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
    expect(result).toEqual({ channel: "signal", messageId: "sm-last" });
  });

  it("returns no-op result for empty payload", async () => {
    const result = await signalPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as never);

    expect(result).toEqual({ channel: "signal", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    // Simulate a chunker that strips whitespace-only input to nothing
    vi.spyOn(signalPlugin.outbound!, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(signalPlugin.outbound!, "sendText");

    const result = await signalPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);

    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "signal", messageId: "" });
  });

  it("chunks long text via text chunker", async () => {
    const sendTextSpy = vi
      .spyOn(signalPlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "signal", messageId: "chunk-last" });

    const longText = "y".repeat(9000);

    const result = await signalPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as never);

    expect(sendTextSpy).toHaveBeenCalledTimes(3);
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "y".repeat(4000) }),
    );
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "y".repeat(4000) }),
    );
    expect(sendTextSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ text: "y".repeat(1000) }),
    );
    expect(result).toEqual({ channel: "signal", messageId: "chunk-last" });
  });
});
