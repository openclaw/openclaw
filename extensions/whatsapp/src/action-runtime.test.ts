import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";

const originalWhatsAppActionRuntime = { ...whatsAppActionRuntime };
const sendReactionWhatsApp = vi.fn(async () => undefined);

const enabledConfig = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as OpenClawConfig;

describe("handleWhatsAppAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalWhatsAppActionRuntime, {
      sendReactionWhatsApp,
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
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith("+123", "msg1", "✅", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: DEFAULT_ACCOUNT_ID,
    });
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
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith("+123", "msg1", "", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: DEFAULT_ACCOUNT_ID,
    });
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
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith("+123", "msg1", "", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: DEFAULT_ACCOUNT_ID,
    });
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
    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith("+123", "msg1", "🎉", {
      verbose: false,
      fromMe: true,
      participant: "999@s.whatsapp.net",
      accountId: "work",
    });
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

    expect(sendReactionWhatsApp).toHaveBeenLastCalledWith("+123", "msg1", "✅", {
      verbose: false,
      fromMe: undefined,
      participant: undefined,
      accountId: "work",
    });
  });
});
