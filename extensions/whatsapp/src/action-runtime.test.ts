// Whatsapp tests cover action runtime plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";

const originalWhatsAppActionRuntime = { ...whatsAppActionRuntime };
const editMessageWhatsApp = vi.fn(async () => ({ messageId: "msg1", toJid: "123@s.whatsapp.net" }));
const sendReactionWhatsApp = vi.fn(async () => undefined);
const unsendMessageWhatsApp = vi.fn(async () => ({
  messageId: "msg1",
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

  function expectLastReactionSend(expected: {
    chat: string;
    messageId: string;
    emoji: string;
    accountId: string;
    fromMe?: boolean;
    participant?: string;
  }) {
    const calls = sendReactionWhatsApp.mock.calls as unknown[][];
    const call = calls.at(-1);
    if (!call) {
      throw new Error("expected WhatsApp reaction send");
    }
    expect(call[0]).toBe(expected.chat);
    expect(call[1]).toBe(expected.messageId);
    expect(call[2]).toBe(expected.emoji);
    const options = call[3] as {
      verbose?: unknown;
      fromMe?: unknown;
      participant?: unknown;
      accountId?: unknown;
    };
    expect(options.verbose).toBe(false);
    expect(options.fromMe).toBe(expected.fromMe);
    expect(options.participant).toBe(expected.participant);
    expect(options.accountId).toBe(expected.accountId);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalWhatsAppActionRuntime, {
      editMessageWhatsApp,
      sendReactionWhatsApp,
      unsendMessageWhatsApp,
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
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: DEFAULT_ACCOUNT_ID,
    });
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
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: DEFAULT_ACCOUNT_ID,
    });
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
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
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
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
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
        action: "react",
        chatJid: "12345@g.us",
        messageId: "msg1",
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

    try {
      await handleWhatsAppAction(
        {
          action: "react",
          chatJid: "111@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      );
      throw new Error("expected WhatsApp action authorization error");
    } catch (error) {
      expect((error as { name?: unknown }).name).toBe("ToolAuthorizationError");
      expect((error as { status?: unknown }).status).toBe(403);
    }
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

    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: "work",
    });
  });

  it.each([
    {
      name: "edits own WhatsApp messages through the resolved account",
      params: {
        action: "edit",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        message: "updated text",
      },
      expectedEditText: "updated text",
    },
    {
      name: "accepts text as an edit message alias",
      params: {
        action: "edit",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        text: "updated text",
      },
      expectedEditText: "updated text",
    },
  ])("$name", async ({ params, expectedEditText }) => {
    await handleWhatsAppAction(params, enabledConfig);

    expect(editMessageWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      expectedEditText,
      expect.objectContaining({
        verbose: false,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it.each([
    {
      name: "rejects missing edit text as a tool input error",
      params: {
        action: "edit",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
      },
    },
    {
      name: "rejects empty edit text as a tool input error",
      params: {
        action: "edit",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        message: "   ",
      },
      message: /edit text cannot be empty/,
    },
  ])("$name", async ({ params, message }) => {
    await expect(handleWhatsAppAction(params, enabledConfig)).rejects.toMatchObject({
      ...(message ? { message: expect.stringMatching(message) } : {}),
      name: "ToolInputError",
      status: 400,
    });
    expect(editMessageWhatsApp).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unsends own WhatsApp messages through the resolved account",
      action: "unsend",
      expectedDetails: { ok: true, unsent: true, messageId: "msg1" },
    },
    {
      name: "deletes own WhatsApp messages as an unsend alias",
      action: "delete",
      expectedDetails: { ok: true, deleted: true, messageId: "msg1" },
    },
  ])("$name", async ({ action, expectedDetails }) => {
    const result = await handleWhatsAppAction(
      {
        action,
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
      },
      enabledConfig,
    );

    expect(result.details).toEqual(expectedDetails);
    expect(unsendMessageWhatsApp).toHaveBeenLastCalledWith(
      "+123",
      "msg1",
      expect.objectContaining({
        verbose: false,
        accountId: DEFAULT_ACCOUNT_ID,
      }),
    );
  });

  it.each(["edit", "delete", "unsend"])("respects sendMessage gating for %s", async (action) => {
    const cfg = {
      channels: { whatsapp: { actions: { sendMessage: false } } },
    } as OpenClawConfig;

    await expect(
      handleWhatsAppAction(
        {
          action,
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          ...(action === "edit" ? { message: "updated" } : {}),
        },
        cfg,
      ),
    ).rejects.toThrow(new RegExp(`message ${action} is disabled`));
  });
});
