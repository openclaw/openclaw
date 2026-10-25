// Whatsapp tests cover approval reactions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  maybeResolveWhatsAppApprovalReaction,
  registerWhatsAppApprovalReactionTarget,
  resolveWhatsAppApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import * as whatsappRuntime from "./runtime.js";
import { resolveEquivalentWhatsAppDirectChatJids, resolveJidToE164 } from "./targets-runtime.js";

type LidLookup = NonNullable<
  NonNullable<Parameters<typeof resolveEquivalentWhatsAppDirectChatJids>[1]>["lidLookup"]
>;

const reactionStores = await vi.hoisted(async () =>
  (await import("./approval-reactions.test-support.js")).createWhatsAppReactionStores(),
);
// mock-isolation: Preserve real exports while collecting only this suite's reaction stores.
vi.mock("openclaw/plugin-sdk/approval-reaction-runtime", reactionStores.mockRuntime);

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

const directJid = "15551230000@s.whatsapp.net";
function registerTarget(
  overrides: Partial<Parameters<typeof registerWhatsAppApprovalReactionTarget>[0]> = {},
) {
  return registerWhatsAppApprovalReactionTarget({
    accountId: "default",
    remoteJid: directJid,
    messageId: "approval-message",
    approvalId: "exec-direct",
    approvalKind: "exec",
    allowedDecisions: ["allow-once", "deny"],
    ...overrides,
  });
}
function lookupTarget(
  overrides: Partial<
    Parameters<typeof resolveWhatsAppApprovalReactionTargetWithPersistence>[0]
  > = {},
) {
  return resolveWhatsAppApprovalReactionTargetWithPersistence({
    accountId: "default",
    remoteJid: directJid,
    messageId: "approval-message",
    reactionKey: "👍",
    ...overrides,
  });
}
function resolveReaction(
  overrides: Partial<Parameters<typeof maybeResolveWhatsAppApprovalReaction>[0]> = {},
) {
  return maybeResolveWhatsAppApprovalReaction({
    cfg: approvalConfig(["+15551230000"]),
    accountId: "default",
    msg: buildReactionMessage({ remoteJid: directJid }),
    resolveInboundJid: async () => "+15551230000",
    ...overrides,
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
    reactionStores.forEach((store) => store.clearForTest());
    resolverMocks.resolveWhatsAppApproval.mockReset();
    resolverMocks.resolveWhatsAppApproval.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("registers reaction state when only allow-always is available", async () => {
    expect(
      await registerTarget({
        messageId: "msg-allow-always",
        approvalId: "exec-allow-always",
        allowedDecisions: ["allow-always"],
      }),
    ).toEqual({
      approvalId: "exec-allow-always",
      approvalKind: "exec",
      allowedDecisions: ["allow-always"],
    });
    await expect(
      lookupTarget({ messageId: "msg-allow-always", reactionKey: "♾" }),
    ).resolves.toEqual({
      approvalId: "exec-allow-always",
      approvalKind: "exec",
      decision: "allow-always",
    });
  });

  it.each([undefined, "invalid"] as const)(
    "rejects reaction targets without a valid explicit approval kind: %s",
    async (approvalKind) => {
      expect(
        await registerTarget({
          messageId: "msg-invalid-kind",
          approvalId: "exec-invalid-kind",
          approvalKind: approvalKind as unknown as "exec",
          allowedDecisions: ["allow-once"],
        }),
      ).toBeNull();
    },
  );

  it("resolves a registered reaction target", async () => {
    await registerTarget({ messageId: "msg-1", approvalId: "exec-1" });

    await expect(lookupTarget({ messageId: "msg-1", reactionKey: "👎" })).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it("rejects persisted targets containing an invalid approval decision", async () => {
    const runtime = vi.spyOn(whatsappRuntime, "getOptionalWhatsAppRuntime").mockReturnValue({
      state: {
        openKeyedStoreV2: () => ({
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
      reactionStores.forEach((store) => store.clearForTest());
      await expect(lookupTarget({ messageId: "corrupt-message" })).resolves.toBeNull();
    } finally {
      reactionStores.forEach((store) => store.clearForTest());
      runtime.mockRestore();
    }
  });

  it.each(["plugin", "system-agent"] as const)(
    "authorizes %s group reactions using the participant, not the group chat",
    async (approvalKind) => {
      await registerTarget({
        remoteJid: "120363401234567890@g.us",
        approvalId: "plugin:abc",
        approvalKind,
        allowedDecisions:
          approvalKind === "plugin"
            ? ["allow-once", "allow-always", "deny"]
            : ["allow-once", "deny"],
      });

      const cfg = approvalConfig(["+15551230000"]);
      const logVerboseMessage = vi.fn();
      const react = (participant: string) =>
        resolveReaction({
          cfg,
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
      });
    },
  );

  it("consumes a losing reaction binding and reports the canonical first answer", async () => {
    await registerTarget({ approvalId: "plugin:looks-plugin-but-is-exec" });
    resolverMocks.resolveWhatsAppApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(resolveReaction({ logVerboseMessage })).resolves.toBe(true);

    expect(logVerboseMessage).toHaveBeenCalledWith(
      "whatsapp: approval reaction already resolved id=plugin:looks-plugin-but-is-exec sender=+15551230000 status=denied decision=deny",
    );
    expect(
      logVerboseMessage.mock.calls.some(([message]) =>
        String(message).includes("decision=allow-once"),
      ),
    ).toBe(false);
    await expect(lookupTarget()).resolves.toBeNull();
  });

  it("authorizes direct self-chat reactions from the account owner", async () => {
    await registerTarget({
      remoteJid: "276853659042038@lid",
      approvalId: "exec-self",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const handled = await resolveReaction({
      cfg: approvalConfig(["+15551230001"]),
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
    });
  });

  it.each([
    [
      "outer chat JID",
      "15551230001@s.whatsapp.net",
      "15551230001@s.whatsapp.net",
      "276853659042038@lid",
    ],
    [
      "PN to stored LID",
      "276853659042038@lid",
      "15551230001@s.whatsapp.net",
      undefined,
      "276853659042038@lid",
    ],
    [
      "LID to stored PN",
      "15551230001@s.whatsapp.net",
      "276853659042038@lid",
      undefined,
      undefined,
      "15551230001:0@s.whatsapp.net",
    ],
    ["device-qualified PN", "15551230001@s.whatsapp.net", "15551230001:0@s.whatsapp.net"],
    ["device-qualified LID", "276853659042038@lid", "276853659042038:1@lid"],
  ] as const)(
    "resolves direct approval target drift: %s",
    async (_name, storedRemoteJid, eventRemoteJid, reactionRemoteJid, lidForPn, pnForLid) => {
      await registerTarget({ remoteJid: storedRemoteJid });
      const lidLookup: LidLookup = {
        getLIDForPN: vi.fn().mockResolvedValue(lidForPn ?? null),
        getPNForLID: vi.fn().mockResolvedValue(pnForLid ?? null),
      };

      const handled = await resolveReaction({
        cfg: approvalConfig(["+15551230001"]),
        msg: buildReactionMessage({
          remoteJid: eventRemoteJid,
          reactionRemoteJid,
        }),
        resolveInboundJid: async (jid) => (jid === eventRemoteJid ? "+15551230001" : null),
        resolveReactionTargetJids: async (jid) =>
          resolveEquivalentWhatsAppDirectChatJids(jid, { lidLookup }),
      });

      expect(handled).toBe(true);
      expect(resolverMocks.resolveWhatsAppApproval).toHaveBeenCalledWith({
        cfg: approvalConfig(["+15551230001"]),
        approvalId: "exec-direct",
        approvalKind: "exec",
        decision: "allow-once",
        channel: "whatsapp",
        accountId: "default",
        senderId: "+15551230001",
      });
    },
  );

  it("does not use a group reaction actor as a direct-chat target candidate", async () => {
    await registerTarget();
    const lidLookup: LidLookup = {
      getLIDForPN: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net"),
      getPNForLID: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net"),
    };

    const handled = await resolveReaction({
      msg: buildReactionMessage({
        remoteJid: "120363401234567890@g.us",
        participant: "15551230000@s.whatsapp.net",
      }),
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, { lidLookup }),
    });

    expect(handled).toBe(false);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it("unregisters the matched target candidate when an approval expired", async () => {
    await registerTarget({ approvalId: "exec-expired" });
    resolverMocks.resolveWhatsAppApproval.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );
    resolverMocks.isApprovalNotFoundError.mockReturnValue(true);

    const handled = await resolveReaction({
      msg: buildReactionMessage({ remoteJid: "276853659042038@lid" }),
      resolveReactionTargetJids: async (jid) =>
        resolveEquivalentWhatsAppDirectChatJids(jid, {
          lidLookup: { getPNForLID: vi.fn().mockResolvedValue("15551230000@s.whatsapp.net") },
        }),
    });

    expect(handled).toBe(true);
    await expect(lookupTarget()).resolves.toBeNull();
  });

  it("retains the target and propagates transient failures for durable replay", async () => {
    await registerTarget();
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
    await registerTarget({ approvalId: "exec-peer" });

    const handled = await resolveReaction({
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
    await registerTarget({
      remoteJid: "120363401234567890@g.us",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once"],
    });

    const handled = await resolveReaction({
      msg: buildReactionMessage({ remoteJid: "120363401234567890@g.us" }),
      resolveInboundJid: async () => null,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", directJid, undefined],
    ["group", "120363401234567890@g.us", "15551230000@s.whatsapp.net"],
  ] as const)(
    "requires explicit approvers for %s reactions",
    async (_kind, remoteJid, participant) => {
      await registerTarget({ remoteJid, approvalId: "exec-1", allowedDecisions: ["allow-once"] });
      const handled = await resolveReaction({
        cfg: { channels: { whatsapp: {} } },
        msg: buildReactionMessage({ remoteJid, participant }),
      });
      expect(handled).toBe(true);
      expect(resolverMocks.resolveWhatsAppApproval).not.toHaveBeenCalled();
    },
  );
});
