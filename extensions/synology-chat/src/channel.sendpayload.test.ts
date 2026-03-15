import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: () => ({}),
}));

vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true),
}));

vi.mock("./accounts.js", () => ({
  listAccountIds: () => ["default"],
  resolveAccount: () => ({
    accountId: "default",
    enabled: true,
    incomingUrl: "https://nas.test/webapi/chatbot",
    token: "tok",
    allowInsecureSsl: false,
    dmPolicy: "allowlist",
    allowedUserIds: [],
    webhookPath: "/synology-chat",
    botName: "bot",
  }),
}));

vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: vi.fn(),
}));

import { createSynologyChatPlugin } from "./channel.js";

describe("sendPayload", () => {
  const plugin = createSynologyChatPlugin();
  const sendText = vi
    .fn()
    .mockResolvedValue({ channel: "synology-chat", messageId: "t1", chatId: "u1" });
  const sendMedia = vi
    .fn()
    .mockResolvedValue({ channel: "synology-chat", messageId: "m1", chatId: "u1" });

  beforeEach(() => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ channel: "synology-chat", messageId: "t1", chatId: "u1" });
    sendMedia.mockResolvedValue({ channel: "synology-chat", messageId: "m1", chatId: "u1" });
    plugin.outbound.sendText = sendText;
    plugin.outbound.sendMedia = sendMedia;
  });

  const baseCtx = { cfg: {} as any, to: "123", accountId: "default" };

  it("delegates text-only payload to sendText", async () => {
    const result = await plugin.outbound.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0]).toMatchObject({ text: "hello" });
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "synology-chat", messageId: "t1", chatId: "u1" });
  });

  it("delegates single-media payload to sendMedia", async () => {
    const result = await plugin.outbound.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrl: "https://img.png" },
    } as any);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://img.png" });
    expect(result).toEqual({ channel: "synology-chat", messageId: "m1", chatId: "u1" });
  });

  it("iterates multi-media URLs with caption on first only", async () => {
    const result = await plugin.outbound.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrls: ["https://a.png", "https://b.png", "https://c.png"] },
    } as any);
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://a.png" });
    expect(sendMedia.mock.calls[1][0]).toMatchObject({ text: "", mediaUrl: "https://b.png" });
    expect(sendMedia.mock.calls[2][0]).toMatchObject({ text: "", mediaUrl: "https://c.png" });
    expect(result).toEqual({ channel: "synology-chat", messageId: "m1", chatId: "u1" });
  });

  it("returns no-op for empty payload", async () => {
    const result = await plugin.outbound.sendPayload!({
      ...baseCtx,
      payload: {},
    } as any);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "synology-chat", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    (plugin.outbound as any).chunker = vi.fn().mockReturnValue([]);
    const sendTextSpy = vi.spyOn(plugin.outbound, "sendText");
    const result = await plugin.outbound.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "synology-chat", messageId: "" });
    delete (plugin.outbound as any).chunker;
  });

  it("chunks long text before calling sendText", async () => {
    // Synology Chat has no chunker, so text goes through as single chunk
    const longText = "x".repeat(5000);
    await plugin.outbound.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0].text).toBe(longText);
  });
});
