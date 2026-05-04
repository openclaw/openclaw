import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "../../inbound/types.js";
import { maybeSendAckReaction } from "./ack-reaction.js";

const hoisted = vi.hoisted(() => ({
  sendReactionWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("../../send.js", () => ({
  sendReactionWhatsApp: hoisted.sendReactionWhatsApp,
}));

function createMessage(overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  return {
    id: "msg-1",
    from: "15551234567",
    conversationId: "15551234567",
    to: "15559876543",
    accountId: "default",
    body: "hello",
    chatType: "direct",
    chatId: "15551234567@s.whatsapp.net",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

function createConfig(
  reactionLevel: "off" | "ack" | "minimal" | "extensive",
  extras?: Partial<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>,
): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        reactionLevel,
        ackReaction: {
          emoji: "👀",
          direct: true,
          group: "mentions",
        },
        ...extras,
      },
    },
  } as OpenClawConfig;
}

type AckReactionParams = Parameters<typeof maybeSendAckReaction>[0];

const runAckReaction = (overrides: Partial<AckReactionParams> = {}) =>
  maybeSendAckReaction({
    cfg: createConfig("ack"),
    msg: createMessage(),
    agentId: "agent",
    sessionKey: "whatsapp:default:15551234567",
    conversationId: "15551234567",
    verbose: false,
    accountId: "default",
    info: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  });

const expectAckReactionSent = (accountId: string) => {
  expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
    "15551234567@s.whatsapp.net",
    "msg-1",
    "👀",
    expect.objectContaining({
      verbose: false,
      fromMe: false,
      accountId,
    }),
  );
};

describe("maybeSendAckReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["ack", "minimal", "extensive"] as const)(
    "sends ack reactions when reactionLevel is %s",
    async (reactionLevel) => {
      const ackReaction = await runAckReaction({
        cfg: createConfig(reactionLevel),
      });

      expect(ackReaction?.ackReactionValue).toBe("👀");
      await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
      expectAckReactionSent("default");
    },
  );

  it("suppresses ack reactions when reactionLevel is off", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off"),
    });

    expect(ackReaction).toBeNull();
    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it.each(["/new", "/reset"])(
    "sends a signature reaction for authorized bare group %s",
    async (body) => {
      await runAckReaction({
        cfg: createConfig("extensive", {
          workIntakeReaction: {
            emoji: "👨🏻‍💻",
            direct: true,
            group: "always",
            cooldownMs: 0,
          },
        }),
        msg: createMessage({
          body,
          chatType: "group",
          chatId: "120@g.us",
          from: "120@g.us",
          conversationId: "120@g.us",
          sender: { jid: "999@s.whatsapp.net" },
          senderJid: "203873608286239:51@lid",
        }),
        commandAuthorized: true,
      });

      expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith("120@g.us", "msg-1", "👨🏻‍💻", {
        verbose: false,
        fromMe: false,
        participant: "203873608286239:51@lid",
        accountId: "default",
        cfg: expect.any(Object),
      });
    },
  );

  it("suppresses automatic reactions for unauthorized bare group /new", async () => {
    await runAckReaction({
      cfg: createConfig("extensive", {
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "/new",
        chatType: "group",
        chatId: "120@g.us",
        from: "120@g.us",
        conversationId: "120@g.us",
      }),
      commandAuthorized: false,
    });

    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("uses the active account reactionLevel override for ack gating", async () => {
    const ackReaction = await runAckReaction({
      cfg: createConfig("off", {
        accounts: {
          work: {
            reactionLevel: "ack",
          },
        },
      }),
      msg: createMessage({
        accountId: "work",
      }),
      sessionKey: "whatsapp:work:15551234567",
      accountId: "work",
    });

    expect(ackReaction?.ackReactionValue).toBe("👀");
    expectAckReactionSent("work");
  });

  it("returns a handle that removes the ack with an empty reaction", async () => {
    const ackReaction = await runAckReaction();

    await ackReaction?.remove();

    expect(hoisted.sendReactionWhatsApp).toHaveBeenLastCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "",
      expect.objectContaining({
        verbose: false,
        fromMe: false,
        accountId: "default",
      }),
    );
  });

  it("records ack send failures on the handle", async () => {
    const warn = vi.fn();
    hoisted.sendReactionWhatsApp.mockRejectedValueOnce(new Error("session down"));

    const ackReaction = await runAckReaction({ warn });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "session down",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-1",
      }),
      "failed to send ack reaction",
    );
  });

  it("sends work-intake reactions without generic ackReaction", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("extensive", {
        ackReaction: undefined,
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "please fix this backend issue",
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:15551234567",
      conversationId: "15551234567",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith(
      "15551234567@s.whatsapp.net",
      "msg-1",
      "👨🏻‍💻",
      {
        verbose: false,
        fromMe: false,
        participant: undefined,
        accountId: "default",
        cfg: expect.any(Object),
      },
    );
  });

  it("adds group participant on work-intake reactions", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("extensive", {
        ackReaction: undefined,
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "okay go, patch the source code",
        chatType: "group",
        chatId: "120@g.us",
        from: "120@g.us",
        conversationId: "120@g.us",
        sender: { jid: "999@s.whatsapp.net" },
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:120@g.us",
      conversationId: "120@g.us",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith("120@g.us", "msg-1", "👨🏻‍💻", {
      verbose: false,
      fromMe: false,
      participant: "999@s.whatsapp.net",
      accountId: "default",
      cfg: expect.any(Object),
    });
  });

  it("preserves raw device-scoped LID participants for group work-intake reactions", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("extensive", {
        ackReaction: undefined,
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "please patch this source issue",
        chatType: "group",
        chatId: "120@g.us",
        from: "120@g.us",
        conversationId: "120@g.us",
        sender: { jid: "203873608286239@lid" },
        senderJid: "203873608286239:51@lid",
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:120@g.us",
      conversationId: "120@g.us",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith("120@g.us", "msg-1", "👨🏻‍💻", {
      verbose: false,
      fromMe: false,
      participant: "203873608286239:51@lid",
      accountId: "default",
      cfg: expect.any(Object),
    });
  });

  it("preserves raw device-scoped LID participants for group ack reactions", async () => {
    const ackReaction = await runAckReaction({
      msg: createMessage({
        body: "shoar check this",
        chatType: "group",
        chatId: "120@g.us",
        from: "120@g.us",
        conversationId: "120@g.us",
        sender: { jid: "203873608286239@lid" },
        senderJid: "203873608286239:51@lid",
        wasMentioned: true,
      }),
      sessionKey: "whatsapp:default:120@g.us",
      conversationId: "120@g.us",
    });

    await expect(ackReaction?.ackReactionPromise).resolves.toBe(true);
    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith("120@g.us", "msg-1", "👀", {
      verbose: false,
      fromMe: false,
      participant: "203873608286239:51@lid",
      accountId: "default",
      cfg: expect.any(Object),
    });
  });

  it("does not send work-intake reactions for neutral messages", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("extensive", {
        ackReaction: undefined,
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "haha this is wild",
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:15551234567",
      conversationId: "15551234567",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("does not send group work-intake reactions for keyword-only code chatter", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("extensive", {
        ackReaction: undefined,
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "this code thing is so weird",
        chatType: "group",
        chatId: "120@g.us",
        from: "120@g.us",
        conversationId: "120@g.us",
        sender: { jid: "999@s.whatsapp.net" },
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:120@g.us",
      conversationId: "120@g.us",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it("sends group work-intake reactions for metadata self-mentions with task verbs", async () => {
    await maybeSendAckReaction({
      cfg: createConfig("extensive", {
        ackReaction: undefined,
        workIntakeReaction: {
          emoji: "👨🏻‍💻",
          direct: true,
          group: "always",
          cooldownMs: 0,
        },
      }),
      msg: createMessage({
        body: "check this",
        chatType: "group",
        chatId: "120@g.us",
        from: "120@g.us",
        conversationId: "120@g.us",
        sender: { jid: "999@s.whatsapp.net" },
        wasMentioned: true,
      }),
      agentId: "agent",
      sessionKey: "whatsapp:default:120@g.us",
      conversationId: "120@g.us",
      verbose: false,
      accountId: "default",
      info: vi.fn(),
      warn: vi.fn(),
    });

    expect(hoisted.sendReactionWhatsApp).toHaveBeenCalledWith("120@g.us", "msg-1", "👨🏻‍💻", {
      verbose: false,
      fromMe: false,
      participant: "999@s.whatsapp.net",
      accountId: "default",
      cfg: expect.any(Object),
    });
  });
});
