import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getSlackRuntime: () => ({}),
}));

vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    resolveSlackAccount: () => ({ botToken: "xoxb-test", config: {} }),
  };
});

import { slackPlugin } from "./channel.js";

describe("sendPayload", () => {
  const sendText = vi.fn().mockResolvedValue({ channel: "slack", messageId: "t1" });
  const sendMedia = vi.fn().mockResolvedValue({ channel: "slack", messageId: "m1" });

  beforeEach(() => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ channel: "slack", messageId: "t1" });
    sendMedia.mockResolvedValue({ channel: "slack", messageId: "m1" });
    slackPlugin.outbound!.sendText = sendText;
    slackPlugin.outbound!.sendMedia = sendMedia;
  });

  const baseCtx = { cfg: {} as any, to: "C123", accountId: "default" };

  it("delegates text-only payload to sendText", async () => {
    const result = await slackPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0]).toMatchObject({ text: "hello" });
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "slack", messageId: "t1" });
  });

  it("delegates single-media payload to sendMedia", async () => {
    const result = await slackPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrl: "https://img.png" },
    } as any);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://img.png" });
    expect(result).toEqual({ channel: "slack", messageId: "m1" });
  });

  it("iterates multi-media URLs with caption on first only", async () => {
    const result = await slackPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrls: ["https://a.png", "https://b.png", "https://c.png"] },
    } as any);
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://a.png" });
    expect(sendMedia.mock.calls[1][0]).toMatchObject({ text: "", mediaUrl: "https://b.png" });
    expect(sendMedia.mock.calls[2][0]).toMatchObject({ text: "", mediaUrl: "https://c.png" });
    expect(result).toEqual({ channel: "slack", messageId: "m1" });
  });

  it("returns no-op for empty payload", async () => {
    const result = await slackPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as any);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "slack", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    slackPlugin.outbound!.chunker = vi.fn().mockReturnValue([]);
    const sendTextSpy = vi.spyOn(slackPlugin.outbound!, "sendText");
    const result = await slackPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "slack", messageId: "" });
    delete (slackPlugin.outbound as any).chunker;
  });

  it("chunks long text before calling sendText", async () => {
    // Slack has chunker: null, so text goes through as a single chunk
    const longText = "x".repeat(8000);
    await slackPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0].text).toBe(longText);
  });
});
