// Whatsapp tests cover action runtime plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";

const originalWhatsAppActionRuntime = { ...whatsAppActionRuntime };
const sendReactionWhatsApp = vi.fn(async () => undefined);

const enabledConfig = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as OpenClawConfig;

const reaction = {
  action: "react",
  chatJid: "123@s.whatsapp.net",
  messageId: "msg1",
  emoji: "✅",
};

describe("handleWhatsAppAction", () => {
  function reactionConfig(reactionLevel: "off" | "ack"): OpenClawConfig {
    return {
      channels: { whatsapp: { actions: { reactions: true }, reactionLevel } },
    } as OpenClawConfig;
  }

  function expectLastReactionSend(expected: {
    chat: string;
    messageId: string;
    emoji: string;
    accountId: string;
    fromMe?: boolean;
    participant?: string;
  }) {
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith(
      expected.chat,
      expected.messageId,
      expected.emoji,
      expect.objectContaining({
        verbose: false,
        fromMe: expected.fromMe,
        participant: expected.participant,
        accountId: expected.accountId,
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalWhatsAppActionRuntime, {
      sendReactionWhatsApp,
    });
  });

  it("adds reactions", async () => {
    await handleWhatsAppAction(reaction, enabledConfig);
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("removes reactions on empty emoji", async () => {
    await handleWhatsAppAction(
      {
        ...reaction,
        emoji: "",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("removes reactions when remove flag set", async () => {
    await handleWhatsAppAction(
      {
        ...reaction,
        remove: true,
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("passes account scope and sender flags", async () => {
    await handleWhatsAppAction(
      {
        ...reaction,
        emoji: "🎉",
        accountId: "work",
        fromMe: true,
        participant: "999@s.whatsapp.net",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "🎉",
      accountId: "work",
      fromMe: true,
      participant: "999@s.whatsapp.net",
    });
  });

  it("preserves LID participant ids when forwarding reactions", async () => {
    await handleWhatsAppAction(
      {
        ...reaction,
        chatJid: "12345@g.us",
        emoji: "🎉",
        participant: "123@lid",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "12345@g.us",
      messageId: "msg1",
      emoji: "🎉",
      accountId: DEFAULT_ACCOUNT_ID,
      participant: "123@lid",
    });
  });

  it("disables reactions when WhatsApp is not configured", async () => {
    await expect(handleWhatsAppAction(reaction, {} as OpenClawConfig)).rejects.toThrow(
      /WhatsApp reactions are disabled/,
    );
  });

  it("prefers the action gate error when both actions.reactions and reactionLevel disable reactions", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { reactions: false }, reactionLevel: "ack" } },
    } as OpenClawConfig;

    await expect(handleWhatsAppAction(reaction, cfg)).rejects.toThrow(
      /WhatsApp reactions are disabled/,
    );
    expect(sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it.each(["off", "ack"] as const)(
    "blocks agent reactions when reactionLevel is %s",
    async (reactionLevel) => {
      await expect(handleWhatsAppAction(reaction, reactionConfig(reactionLevel))).rejects.toThrow(
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
          ...reaction,
          chatJid: "111@s.whatsapp.net",
        },
        cfg,
      ),
    ).rejects.toMatchObject({ name: "ToolAuthorizationError", status: 403 });
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

    await handleWhatsAppAction(reaction, cfg);

    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: "work",
    });
  });
});
