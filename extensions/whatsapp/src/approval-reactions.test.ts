import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWhatsAppApprovalReactionHint,
  clearWhatsAppApprovalReactionTargetsForTest,
  extractWhatsAppApprovalPromptBinding,
  maybeResolveWhatsAppApprovalReaction,
  registerWhatsAppApprovalReactionTargetForOutboundMessage,
  registerWhatsAppApprovalReactionTarget,
  resolveWhatsAppApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";

const resolverMocks = vi.hoisted(() => ({
  resolveWhatsAppApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("./approval-resolver.js", () => ({
  resolveWhatsAppApproval: resolverMocks.resolveWhatsAppApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

describe("WhatsApp approval reactions", () => {
  beforeEach(() => {
    clearWhatsAppApprovalReactionTargetsForTest();
    resolverMocks.resolveWhatsAppApproval.mockReset();
    resolverMocks.resolveWhatsAppApproval.mockResolvedValue(undefined);
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("renders numeric reaction choices for allowed decisions", () => {
    expect(buildWhatsAppApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React with:\n\n1️⃣ Allow Once\n3️⃣ Deny",
    );
  });

  it("resolves a registered reaction target", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "15551230000@s.whatsapp.net",
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });

    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "msg-1",
        reactionKey: "3️⃣",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      decision: "deny",
    });
  });

  it("extracts approval bindings from explicit outbound prompts", async () => {
    expect(
      extractWhatsAppApprovalPromptBinding(
        [
          "Plugin approval required",
          "ID: plugin:abc",
          "Reply with: /approve plugin:abc allow-once|allow-always|deny",
        ].join("\n"),
      ),
    ).toEqual({
      approvalId: "plugin:abc",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    expect(
      registerWhatsAppApprovalReactionTargetForOutboundMessage({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "prompt-message",
        text: "Reply with: /approve exec-1 allow-once|deny",
      }),
    ).toBe(true);

    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "prompt-message",
        reactionKey: "3️⃣",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      decision: "deny",
    });
  });

  it("authorizes group reactions using the participant, not the group chat", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "120363401234567890@g.us",
      messageId: "approval-message",
      approvalId: "plugin:abc",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551230000"],
          },
        },
      },
      accountId: "default",
      msg: {
        key: {
          remoteJid: "120363401234567890@g.us",
          participant: "15551230000@s.whatsapp.net",
          fromMe: false,
        },
        message: {
          reactionMessage: {
            text: "1️⃣",
            key: {
              remoteJid: "120363401234567890@g.us",
              id: "approval-message",
            },
          },
        },
      } as never,
      resolveInboundJid: async (jid) =>
        jid === "15551230000@s.whatsapp.net" ? "+15551230000" : null,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551230000"],
          },
        },
      },
      approvalId: "plugin:abc",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("authorizes direct self-chat reactions from the account owner", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "276853659042038@lid",
      messageId: "approval-message",
      approvalId: "exec-self",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551230001"],
          },
        },
      },
      accountId: "default",
      msg: {
        key: {
          id: "reaction-message",
          remoteJid: "276853659042038@lid",
          fromMe: true,
        },
        message: {
          reactionMessage: {
            text: "1️⃣",
            key: {
              remoteJid: "276853659042038@lid",
              id: "approval-message",
              fromMe: true,
            },
          },
        },
      } as never,
      selfLid: "276853659042038@lid",
      resolveInboundJid: async (jid) => (jid === "276853659042038@lid" ? "+15551230001" : null),
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551230001"],
          },
        },
      },
      approvalId: "exec-self",
      decision: "allow-once",
      senderId: "+15551230001",
      gatewayUrl: undefined,
    });
  });

  it("does not attribute a peer DM fromMe reaction to the peer", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "15551230000@s.whatsapp.net",
      messageId: "approval-message",
      approvalId: "exec-peer",
      allowedDecisions: ["allow-once", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551230000"],
          },
        },
      },
      accountId: "default",
      msg: {
        key: {
          id: "reaction-message",
          remoteJid: "15551230000@s.whatsapp.net",
          fromMe: true,
        },
        message: {
          reactionMessage: {
            text: "1️⃣",
            key: {
              remoteJid: "15551230000@s.whatsapp.net",
              id: "approval-message",
              fromMe: true,
            },
          },
        },
      } as never,
      selfLid: "276853659042038@lid",
      resolveInboundJid: async (jid) => {
        if (jid === "15551230000@s.whatsapp.net") {
          return "+15551230000";
        }
        if (jid === "276853659042038@lid") {
          return "+15551230001";
        }
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("fails closed when a group reaction is missing actor identity", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "120363401234567890@g.us",
      messageId: "approval-message",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15551230000"],
          },
        },
      },
      accountId: "default",
      msg: {
        key: {
          remoteJid: "120363401234567890@g.us",
          fromMe: false,
        },
        message: {
          reactionMessage: {
            text: "1️⃣",
            key: {
              remoteJid: "120363401234567890@g.us",
              id: "approval-message",
            },
          },
        },
      } as never,
      resolveInboundJid: async () => null,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for group approval reactions", async () => {
    registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: "120363401234567890@g.us",
      messageId: "approval-message",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: {
        channels: {
          whatsapp: {},
        },
      },
      accountId: "default",
      msg: {
        key: {
          remoteJid: "120363401234567890@g.us",
          participant: "15551230000@s.whatsapp.net",
          fromMe: false,
        },
        message: {
          reactionMessage: {
            text: "1️⃣",
            key: {
              remoteJid: "120363401234567890@g.us",
              id: "approval-message",
            },
          },
        },
      } as never,
      resolveInboundJid: async () => "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });
});
