import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string, limit: number) => {
          if (text.length <= limit) return [text];
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
          return chunks;
        },
      },
      media: { fetchRemoteMedia: vi.fn() },
    },
  }),
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage: vi.fn(),
  uploadGoogleChatAttachment: vi.fn(),
  probeGoogleChat: vi.fn(),
}));

vi.mock("./targets.js", () => ({
  isGoogleChatSpaceTarget: () => true,
  isGoogleChatUserTarget: () => false,
  normalizeGoogleChatTarget: (t: string) => t,
  resolveGoogleChatOutboundSpace: async () => "spaces/test",
}));

vi.mock("./accounts.js", () => ({
  listGoogleChatAccountIds: () => ["default"],
  resolveDefaultGoogleChatAccountId: () => "default",
  resolveGoogleChatAccount: () => ({
    accountId: "default",
    enabled: true,
    credentialSource: "inline",
    config: {},
  }),
}));

vi.mock("./actions.js", () => ({
  googlechatMessageActions: { listActions: () => [], extractToolSend: () => null },
}));

vi.mock("./monitor.js", () => ({
  resolveGoogleChatWebhookPath: () => "/googlechat",
  startGoogleChatMonitor: vi.fn(),
}));

vi.mock("./onboarding.js", () => ({
  googlechatOnboardingAdapter: {},
}));

import { googlechatPlugin } from "./channel.js";

describe("sendPayload", () => {
  const sendText = vi
    .fn()
    .mockResolvedValue({ channel: "googlechat", messageId: "t1", chatId: "spaces/test" });
  const sendMedia = vi
    .fn()
    .mockResolvedValue({ channel: "googlechat", messageId: "m1", chatId: "spaces/test" });

  beforeEach(() => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ channel: "googlechat", messageId: "t1", chatId: "spaces/test" });
    sendMedia.mockResolvedValue({ channel: "googlechat", messageId: "m1", chatId: "spaces/test" });
    googlechatPlugin.outbound!.sendText = sendText;
    googlechatPlugin.outbound!.sendMedia = sendMedia;
  });

  const baseCtx = { cfg: {} as any, to: "spaces/test", accountId: "default" };

  it("delegates text-only payload to sendText", async () => {
    const result = await googlechatPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0]).toMatchObject({ text: "hello" });
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toMatchObject({ channel: "googlechat", messageId: "t1" });
  });

  it("delegates single-media payload to sendMedia", async () => {
    const result = await googlechatPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrl: "https://img.png" },
    } as any);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://img.png" });
    expect(result).toMatchObject({ channel: "googlechat", messageId: "m1" });
  });

  it("iterates multi-media URLs with caption on first only", async () => {
    const result = await googlechatPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrls: ["https://a.png", "https://b.png", "https://c.png"] },
    } as any);
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://a.png" });
    expect(sendMedia.mock.calls[1][0]).toMatchObject({ text: "", mediaUrl: "https://b.png" });
    expect(sendMedia.mock.calls[2][0]).toMatchObject({ text: "", mediaUrl: "https://c.png" });
    expect(result).toMatchObject({ channel: "googlechat", messageId: "m1" });
  });

  it("returns no-op for empty payload", async () => {
    const result = await googlechatPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    } as any);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "googlechat", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi.spyOn(googlechatPlugin.outbound! as any, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(googlechatPlugin.outbound!, "sendText");
    const result = await googlechatPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "googlechat", messageId: "" });
    chunkerSpy.mockRestore();
  });

  it("chunks long text before calling sendText", async () => {
    const longText = "x".repeat(8000);
    await googlechatPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as any);
    // textChunkLimit is 4000, chunker splits into 2 chunks
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[0][0].text).toBe("x".repeat(4000));
    expect(sendText.mock.calls[1][0].text).toBe("x".repeat(4000));
  });
});
