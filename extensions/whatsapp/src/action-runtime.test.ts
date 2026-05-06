import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";

const originalWhatsAppActionRuntime = { ...whatsAppActionRuntime };
const sendReactionWhatsApp = vi.fn(async () => undefined);
const sendLocationWhatsApp = vi.fn(async () => ({
  messageId: "loc-1",
  toJid: "123@s.whatsapp.net",
}));

const enabledConfig = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as OpenClawConfig;

describe("handleWhatsAppAction", () => {
  function reactionConfig(reactionLevel: "minimal" | "extensive" | "off" | "ack"): OpenClawConfig {
    return {
      channels: { whatsapp: { actions: { reactions: true }, reactionLevel } },
    } as OpenClawConfig;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalWhatsAppActionRuntime, {
      sendReactionWhatsApp,
      sendLocationWhatsApp,
    });
  });

  it("adds reactions", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "✅",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: undefined,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it("adds reactions when reactionLevel is minimal", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      reactionConfig("minimal"),
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "✅",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: undefined,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it("adds reactions when reactionLevel is extensive", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      reactionConfig("extensive"),
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "✅",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: undefined,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it("removes reactions on empty emoji", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: undefined,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it("removes reactions when remove flag set", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
        remove: true,
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: undefined,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it("passes account scope and sender flags", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "🎉",
        accountId: "work",
        fromMe: true,
        participant: "999@s.whatsapp.net",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "🎉",
      expect.objectContaining({
        verbose: false,
        fromMe: true,
        participant: "999@s.whatsapp.net",
        accountId: "work",
      }),
    );
  });

  it("preserves LID participant ids when forwarding reactions", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "msg1",
        emoji: "🎉",
        participant: "123@lid",
      },
      enabledConfig,
    );
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "12345@g.us",
      "msg1",
      "🎉",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: "123@lid",
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it("sends native locations", async () => {
    const result = await handleWhatsAppAction(
      {
        action: "location",
        to: "+123",
        latitude: 18.4861,
        longitude: -69.9312,
        locationName: "Santo Domingo",
        locationAddress: "Distrito Nacional",
      },
      enabledConfig,
    );

    expect(sendLocationWhatsApp).toHaveBeenCalledWith(
      "+123",
      {
        latitude: 18.4861,
        longitude: -69.9312,
        locationName: "Santo Domingo",
        locationAddress: "Distrito Nacional",
        accuracyInMeters: undefined,
      },
      expect.objectContaining({
        verbose: false,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          ok: true,
          messageId: "loc-1",
          toJid: "123@s.whatsapp.net",
        }),
      }),
    );
  });

  it("rejects negative accuracy for native locations", async () => {
    await expect(
      handleWhatsAppAction(
        {
          action: "location",
          to: "+123",
          latitude: 18.4861,
          longitude: -69.9312,
          accuracyInMeters: -5,
        },
        enabledConfig,
      ),
    ).rejects.toThrow(/accuracyInMeters must be a non-negative number/);
    expect(sendLocationWhatsApp).not.toHaveBeenCalled();
  });

  it("respects reaction gating", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { reactions: false } } },
    } as OpenClawConfig;
    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
  });

  it("disables reactions when WhatsApp is not configured", async () => {
    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        {} as OpenClawConfig,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
  });

  it("prefers the action gate error when both actions.reactions and reactionLevel disable reactions", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { reactions: false }, reactionLevel: "ack" } },
    } as OpenClawConfig;

    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
    expect(sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it.each(["off", "ack"] as const)(
    "blocks agent reactions when reactionLevel is %s",
    async (reactionLevel) => {
      await expect(
        handleWhatsAppAction(
          {
            action: "react",
            chatJid: "123@s.whatsapp.net",
            messageId: "msg1",
            emoji: "✅",
          },
          reactionConfig(reactionLevel),
        ),
      ).rejects.toThrow(
        new RegExp(`WhatsApp agent reactions disabled \\(reactionLevel="${reactionLevel}"\\)`),
      );
      expect(sendReactionWhatsApp).not.toHaveBeenCalled();
    },
  );

  it("applies default account allowFrom when accountId is omitted", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: true },
          allowFrom: ["111@s.whatsapp.net"],
          accounts: {
            [DEFAULT_ACCOUNT_ID]: {
              allowFrom: ["222@s.whatsapp.net"],
            },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "111@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toMatchObject({
      name: "ToolAuthorizationError",
      status: 403,
    });
  });

  it("routes to resolved default account when no accountId is provided", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: true },
          accounts: {
            work: {
              allowFrom: ["123@s.whatsapp.net"],
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      cfg,
    );

    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      "✅",
      expect.objectContaining({
        verbose: false,
        fromMe: undefined,
        participant: undefined,
        accountId: "work",
      }),
    );
  });
});
