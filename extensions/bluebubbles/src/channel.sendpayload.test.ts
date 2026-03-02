import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./send.js", () => ({
  sendMessageBlueBubbles: vi.fn().mockResolvedValue({ messageId: "bb-msg-1" }),
}));

vi.mock("./media-send.js", () => ({
  sendBlueBubblesMedia: vi.fn().mockResolvedValue({ messageId: "bb-media-1" }),
}));

vi.mock("./monitor.js", () => ({
  resolveBlueBubblesMessageId: vi.fn().mockReturnValue(""),
  monitorBlueBubblesProvider: vi.fn(),
  resolveWebhookPathFromConfig: vi.fn().mockReturnValue("/webhook"),
}));

vi.mock("./probe.js", () => ({
  probeBlueBubbles: vi.fn(),
}));

import { bluebubblesPlugin } from "./channel.js";

describe("bluebubblesPlugin sendPayload", () => {
  const cfg = { channels: { bluebubbles: {} } };
  const baseCtx = {
    cfg,
    to: "chat_guid:iMessage;-;+15551234567",
    text: "",
    accountId: "default",
    payload: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates text-only payload to sendText", async () => {
    const sendTextSpy = vi
      .spyOn(bluebubblesPlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "bluebubbles", messageId: "b-1" });

    const result = await bluebubblesPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello bb" },
    } as never);

    expect(sendTextSpy).toHaveBeenCalledOnce();
    expect(sendTextSpy).toHaveBeenCalledWith(expect.objectContaining({ text: "hello bb" }));
    expect(result).toEqual({ channel: "bluebubbles", messageId: "b-1" });
  });

  it("delegates single media URL to sendMedia with caption", async () => {
    const sendMediaSpy = vi
      .spyOn(bluebubblesPlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "bluebubbles", messageId: "bm-1" });

    const result = await bluebubblesPlugin.outbound!.sendPayload!({
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
    expect(result).toEqual({ channel: "bluebubbles", messageId: "bm-1" });
  });

  it("iterates multiple media URLs with caption on first only", async () => {
    const sendMediaSpy = vi
      .spyOn(bluebubblesPlugin.outbound!, "sendMedia")
      .mockResolvedValue({ channel: "bluebubbles", messageId: "bm-last" });

    const result = await bluebubblesPlugin.outbound!.sendPayload!({
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
    expect(result).toEqual({ channel: "bluebubbles", messageId: "bm-last" });
  });

  it("returns no-op result for empty payload", async () => {
    const result = await bluebubblesPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as never);

    expect(result).toEqual({ channel: "bluebubbles", messageId: "" });
  });

  it("sends text as single chunk when no chunker is defined", async () => {
    // BlueBubbles has no chunker, so text is sent as a single chunk via [text] fallback
    const sendTextSpy = vi
      .spyOn(bluebubblesPlugin.outbound!, "sendText")
      .mockResolvedValue({ channel: "bluebubbles", messageId: "b-full" });

    const longText = "w".repeat(9000);

    const result = await bluebubblesPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as never);

    // No chunker means the entire text is sent as one chunk
    expect(sendTextSpy).toHaveBeenCalledOnce();
    expect(sendTextSpy).toHaveBeenCalledWith(expect.objectContaining({ text: longText }));
    expect(result).toEqual({ channel: "bluebubbles", messageId: "b-full" });
  });
});
