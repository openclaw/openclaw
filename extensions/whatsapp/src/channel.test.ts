import type { OpenClawConfig } from "openclaw/plugin-sdk/whatsapp";
import { describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

const handleWhatsAppAction = vi.fn(async () => ({ details: { ok: true } }));
vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    channel: {
      whatsapp: { handleWhatsAppAction },
      text: { chunkText: (t: string) => [t] },
    },
  }),
}));

const reactCfg = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as OpenClawConfig;

describe("whatsappPlugin actions react", () => {
  it("falls back to toolContext.currentMessageId when messageId is omitted", async () => {
    handleWhatsAppAction.mockClear();
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { chatJid: "123@s.whatsapp.net", emoji: "👍" },
      cfg: reactCfg,
      toolContext: { currentMessageId: "msg-ctx-42" },
    });
    expect(handleWhatsAppAction).toHaveBeenCalledTimes(1);
    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg-ctx-42" }),
      reactCfg,
    );
  });

  it("prefers explicit messageId over toolContext fallback", async () => {
    handleWhatsAppAction.mockClear();
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      params: { chatJid: "123@s.whatsapp.net", messageId: "explicit-1", emoji: "🔥" },
      cfg: reactCfg,
      toolContext: { currentMessageId: "ctx-fallback" },
    });
    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "explicit-1" }),
      reactCfg,
    );
  });

  it("rejects reaction when neither messageId nor toolContext is available", async () => {
    await expect(
      whatsappPlugin.actions!.handleAction!({
        channel: "whatsapp",
        action: "react",
        params: { chatJid: "123@s.whatsapp.net", emoji: "✅" },
        cfg: reactCfg,
      }),
    ).rejects.toThrow(/messageId required/);
  });
});

describe("whatsappPlugin outbound sendMedia", () => {
  it("forwards mediaLocalRoots to sendMessageWhatsApp", async () => {
    const sendWhatsApp = vi.fn(async () => ({
      messageId: "msg-1",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const outbound = whatsappPlugin.outbound;
    if (!outbound?.sendMedia) {
      throw new Error("whatsapp outbound sendMedia is unavailable");
    }

    const result = await outbound.sendMedia({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendWhatsApp },
      gifPlayback: false,
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "photo",
      expect.objectContaining({
        verbose: false,
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
        gifPlayback: false,
      }),
    );
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "msg-1" });
  });
});
