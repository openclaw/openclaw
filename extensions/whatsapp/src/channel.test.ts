import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";
import { setWhatsAppRuntime } from "./runtime.js";

const handleWhatsAppAction = vi.fn(async () => ({ type: "json", data: { ok: true } }));

function installRuntime() {
  setWhatsAppRuntime({
    channel: {
      whatsapp: { handleWhatsAppAction },
    },
  } as never);
}

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

const enabledConfig = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as OpenClawConfig;

describe("whatsappPlugin.actions.handleAction react participant fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
  });

  it("uses requesterSenderId as participant fallback for @s.whatsapp.net JIDs", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      cfg: enabledConfig,
      params: {
        chatJid: "group123@g.us",
        messageId: "msg1",
        emoji: "✅",
      },
      requesterSenderId: "201006884440@s.whatsapp.net",
    });

    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({
        participant: "201006884440@s.whatsapp.net",
      }),
      enabledConfig,
    );
  });

  it("uses requesterSenderId as participant fallback for @lid JIDs", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      cfg: enabledConfig,
      params: {
        chatJid: "group123@g.us",
        messageId: "msg1",
        emoji: "✅",
      },
      requesterSenderId: "143134247891105@lid",
    });

    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({
        participant: "143134247891105@lid",
      }),
      enabledConfig,
    );
  });

  it("ignores requesterSenderId from non-WhatsApp contexts", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      cfg: enabledConfig,
      params: {
        chatJid: "group123@g.us",
        messageId: "msg1",
        emoji: "✅",
      },
      requesterSenderId: "discord-user-123",
    });

    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({
        participant: undefined,
      }),
      enabledConfig,
    );
  });

  it("prefers explicit participant param over requesterSenderId", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      cfg: enabledConfig,
      params: {
        chatJid: "group123@g.us",
        messageId: "msg1",
        emoji: "✅",
        participant: "explicit@s.whatsapp.net",
      },
      requesterSenderId: "fallback@s.whatsapp.net",
    });

    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({
        participant: "explicit@s.whatsapp.net",
      }),
      enabledConfig,
    );
  });

  it("passes undefined participant when both param and requesterSenderId are absent", async () => {
    await whatsappPlugin.actions!.handleAction!({
      channel: "whatsapp",
      action: "react",
      cfg: enabledConfig,
      params: {
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
    });

    expect(handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({
        participant: undefined,
      }),
      enabledConfig,
    );
  });
});
