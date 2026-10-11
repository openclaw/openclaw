// Whatsapp tests cover approval reactions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWhatsAppApprovalReactionTargetsForTest,
  maybeResolveWhatsAppApprovalReaction,
  registerWhatsAppApprovalReactionTarget,
  resolveWhatsAppApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import * as whatsappRuntime from "./runtime.js";
import { resolveEquivalentWhatsAppDirectChatJids, resolveJidToE164 } from "./targets-runtime.js";

type LidLookup = NonNullable<
  NonNullable<Parameters<typeof resolveEquivalentWhatsAppDirectChatJids>[1]>["lidLookup"]
>;

const resolverMocks = vi.hoisted(() => ({
  resolveWhatsAppApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveWhatsAppApproval,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return {
    ...actual,
    isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
  };
});

function approvalConfig(allowFrom: string[]) {
  return {
    channels: {
      whatsapp: {
        allowFrom,
      },
    },
  };
}

async function registerExecApprovalTarget(params: {
  remoteJid: string;
  approvalId?: string;
  allowedDecisions?: Parameters<
    typeof registerWhatsAppApprovalReactionTarget
  >[0]["allowedDecisions"];
}): Promise<void> {
  await registerWhatsAppApprovalReactionTarget({
    accountId: "default",
    remoteJid: params.remoteJid,
    messageId: "approval-message",
    approvalId: params.approvalId ?? "exec-direct",
    approvalKind: "exec",
    allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
  });
}

function buildReactionMessage(params: {
  remoteJid: string;
  reactionRemoteJid?: string;
  participant?: string;
  fromMe?: boolean;
  reactionFromMe?: boolean;
}) {
  return {
    key: {
      id: "reaction-message",
      remoteJid: params.remoteJid,
      ...(params?.participant ? { participant: params.participant } : {}),
      fromMe: params.fromMe ?? false,
    },
    message: {
      reactionMessage: {
        text: "👍",
        key: {
          remoteJid: params.reactionRemoteJid ?? params.remoteJid,
          id: "approval-message",
          ...(params.reactionFromMe === undefined ? {} : { fromMe: params.reactionFromMe }),
        },
      },
    },
  } as never;
}

describe("WhatsApp approval reactions", () => {
  beforeEach(() => {
    clearWhatsAppApprovalReactionTargetsForTest();
    resolverMocks.resolveWhatsAppApproval.mockReset();
    resolverMocks.resolveWhatsAppApproval.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it.each([undefined] as const)(
    "rejects reaction targets without a valid explicit approval kind: %s",
    async (approvalKind) => {
      expect(
        await registerWhatsAppApprovalReactionTarget({
          accountId: "default",
          remoteJid: "15551230000@s.whatsapp.net",
          messageId: "msg-invalid-kind",
          approvalId: "exec-invalid-kind",
          // Runtime callers must not register missing or unsupported kinds.
          approvalKind: approvalKind as unknown as "exec",
          allowedDecisions: ["allow-once"],
        }),
      ).toBeNull();
    },
  );

  it("rejects persisted targets containing an invalid approval decision", async () => {
    const runtime = vi.spyOn(whatsappRuntime, "getOptionalWhatsAppRuntime").mockReturnValue({
      state: {
        openKeyedStore: () => ({
          register: async () => {},
          lookup: async () => ({
            version: 1,
            target: {
              approvalId: "exec-corrupt",
              approvalKind: "exec",
              allowedDecisions: ["allow-once", "invalid"],
            },
          }),
          delete: async () => false,
        }),
      },
    } as never);
    try {
      clearWhatsAppApprovalReactionTargetsForTest();
      await expect(
        resolveWhatsAppApprovalReactionTargetWithPersistence({
          accountId: "default",
          remoteJid: "15551230000@s.whatsapp.net",
          messageId: "corrupt-message",
          reactionKey: "👍",
        }),
      ).resolves.toBeNull();
    } finally {
      clearWhatsAppApprovalReactionTargetsForTest();
      runtime.mockRestore();
    }
  });

  it.each(["system-agent"] as const)(
    "authorizes %s group reactions using the participant, not the group chat",
    async (approvalKind) => {
      await registerWhatsAppApprovalReactionTarget({
        accountId: "default",
        remoteJid: "120363401234567890@g.us",
        messageId: "approval-message",
        approvalId: "plugin:abc",
        approvalKind,
        allowedDecisions: ["allow-once", "deny"],
      });

      const cfg = approvalConfig(["+15551230000"]);
      const logVerboseMessage = vi.fn();
      const react = (participant: string) =>
        maybeResolveWhatsAppApprovalReaction({
          cfg,
          accountId: "default",
          msg: buildReactionMessage({
            remoteJid: "120363401234567890@g.us",
            participant,
          }),
          resolveInboundJid: resolveJidToE164,
          logVerboseMessage,
        });

      await expect(react("15551230001@s.whatsapp.net")).resolves.toBe(true);
      expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
      expect(logVerboseMessage).toHaveBeenCalledWith(
        "whatsapp: approval reaction denied id=plugin:abc sender=+15551230001",
      );

      await expect(react("15551230000@s.whatsapp.net")).resolves.toBe(true);
      expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledExactlyOnceWith({
        cfg,
        approvalId: "plugin:abc",
        approvalKind,
        decision: "allow-once",
        channel: "whatsapp",
        accountId: "default",
        senderId: "+15551230000",
        gatewayUrl: undefined,
      });
    },
  );

  it("consumes a losing reaction binding and reports the canonical first answer", async () => {
    await registerExecApprovalTarget({
      remoteJid: "15551230000@s.whatsapp.net",
      approvalId: "plugin:looks-plugin-but-is-exec",
    });
    resolverMocks.resolveWhatsAppApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(
      maybeResolveWhatsAppApprovalReaction({
        cfg: approvalConfig(["+15551230000"]),
        accountId: "default",
        msg: buildReactionMessage({ remoteJid: "15551230000@s.whatsapp.net" }),
        resolveInboundJid: async () => "+15551230000",
        logVerboseMessage,
      }),
    ).resolves.toBe(true);

    expect(logVerboseMessage).toHaveBeenCalledWith(
      "whatsapp: approval reaction already resolved id=plugin:looks-plugin-but-is-exec sender=+15551230000 status=denied decision=deny",
    );
    expect(
      logVerboseMessage.mock.calls.some(([message]) =>
        String(message).includes("decision=allow-once"),
      ),
    ).toBe(false);
    await expect(
      resolveWhatsAppApprovalReactionTargetWithPersistence({
        accountId: "default",
        remoteJid: "15551230000@s.whatsapp.net",
        messageId: "approval-message",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it("authorizes direct self-chat reactions from the account owner", async () => {
    await registerExecApprovalTarget({
      remoteJid: "276853659042038@lid",
      approvalId: "exec-self",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230001"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "276853659042038@lid",
        fromMe: true,
        reactionFromMe: true,
      }),
      selfLid: "276853659042038@lid",
      resolveInboundJid: async (jid) => (jid === "276853659042038@lid" ? "+15551230001" : null),
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: approvalConfig(["+15551230001"]),
      approvalId: "exec-self",
      approvalKind: "exec",
      decision: "allow-once",
      channel: "whatsapp",
      accountId: "default",
      senderId: "+15551230001",
      gatewayUrl: undefined,
    });
  });

  it.each([
    {
      name: "stored PN target from outer chat JID",
      storedRemoteJid: "15551230001@s.whatsapp.net",
      eventRemoteJid: "15551230001@s.whatsapp.net",
      reactionRemoteJid: "276853659042038@lid",
      actorId: "+15551230001",
    },
  ])("resolves direct approval reactions across PN/LID target drift: $name", async (testCase) => {
    await registerExecApprovalTarget({ remoteJid: testCase.storedRemoteJid });
    const lidLookup: LidLookup = {
      getLIDForPN: vi.fn().mockResolvedValue(null),
      getPNForLID: vi.fn().mockResolvedValue(null),
    };

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig([testCase.actorId]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: testCase.eventRemoteJid,
        reactionRemoteJid: testCase.reactionRemoteJid,
      }),
      resolveInboundJid: async (jid) => (jid === testCase.eventRemoteJid ? testCase.actorId : null),
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, { lidLookup }),
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
      cfg: approvalConfig([testCase.actorId]),
      approvalId: "exec-direct",
      approvalKind: "exec",
      decision: "allow-once",
      channel: "whatsapp",
      accountId: "default",
      senderId: testCase.actorId,
      gatewayUrl: undefined,
    });
  });

  it("does not use a group reaction actor as a direct-chat target candidate", async () => {
    await registerExecApprovalTarget({ remoteJid: "15551230000@s.whatsapp.net" });
    const lidLookup: LidLookup = {
      getLIDForPN: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net"),
      getPNForLID: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net"),
    };

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "120363401234567890@g.us",
        participant: "15551230000@s.whatsapp.net",
      }),
      resolveInboundJid: async () => "+15551230000",
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, { lidLookup }),
    });

    expect(handled).toBe(false);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("retains the target and propagates transient failures for durable replay", async () => {
    await registerExecApprovalTarget({ remoteJid: "15551230000@s.whatsapp.net" });
    const gatewayError = new Error("Gateway 503 Service Unavailable");
    resolverMocks.resolveWhatsAppApproval.mockRejectedValueOnce(gatewayError);
    const reaction = {
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({ remoteJid: "15551230000@s.whatsapp.net" }),
      resolveInboundJid: async () => "+15551230000",
    };

    await expect(maybeResolveWhatsAppApprovalReaction(reaction)).rejects.toBe(gatewayError);
    await expect(maybeResolveWhatsAppApprovalReaction(reaction)).resolves.toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledTimes(2);
    expect(resolverMocks.resolveWhatsAppApproval.mock.calls[1]).toEqual(
      resolverMocks.resolveWhatsAppApproval.mock.calls[0],
    );
    await expect(maybeResolveWhatsAppApprovalReaction(reaction)).resolves.toBe(false);
  });

  it("does not attribute a peer DM fromMe reaction to the peer", async () => {
    await registerExecApprovalTarget({
      remoteJid: "15551230000@s.whatsapp.net",
      approvalId: "exec-peer",
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({
        remoteJid: "15551230000@s.whatsapp.net",
        fromMe: true,
        reactionFromMe: true,
      }),
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
    await registerExecApprovalTarget({
      remoteJid: "120363401234567890@g.us",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveWhatsAppApprovalReaction({
      cfg: approvalConfig(["+15551230000"]),
      accountId: "default",
      msg: buildReactionMessage({ remoteJid: "120363401234567890@g.us" }),
      resolveInboundJid: async () => null,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for direct approval reactions", async () => {
    await registerExecApprovalTarget({
      remoteJid: "15551230000@s.whatsapp.net",
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
      msg: buildReactionMessage({ remoteJid: "15551230000@s.whatsapp.net" }),
      resolveInboundJid: async () => "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for group approval reactions", async () => {
    await registerExecApprovalTarget({
      remoteJid: "120363401234567890@g.us",
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
      msg: buildReactionMessage({
        remoteJid: "120363401234567890@g.us",
        participant: "15551230000@s.whatsapp.net",
      }),
      resolveInboundJid: async () => "+15551230000",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });
});
