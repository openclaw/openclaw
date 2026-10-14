// Whatsapp tests cover access control plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  readAllowFromStoreMock,
  sendMessageMock,
  getAccessControlTestConfig,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

setupAccessControlTestHarness();
let checkInboundAccessControl: typeof import("./access-control.js").checkInboundAccessControl;
let resolveWhatsAppCommandAuthorized: typeof import("../inbound-policy.js").resolveWhatsAppCommandAuthorized;

beforeAll(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
  ({ resolveWhatsAppCommandAuthorized } = await import("../inbound-policy.js"));
});

function checkAccess(overrides: Partial<Parameters<typeof checkInboundAccessControl>[0]> = {}) {
  return checkInboundAccessControl({
    cfg: getAccessControlTestConfig() as never,
    accountId: "default",
    from: "+15550001111",
    selfE164: "+15550009999",
    senderE164: "+15550001111",
    group: false,
    pushName: "Sam",
    isFromMe: false,
    sock: { sendMessage: sendMessageMock },
    remoteJid: "15550001111@s.whatsapp.net",
    ...overrides,
  });
}

async function checkUnauthorizedWorkDmSender() {
  return checkInboundAccessControl({
    cfg: getAccessControlTestConfig() as never,
    accountId: "work",
    from: "+15550001111",
    selfE164: "+15550009999",
    senderE164: "+15550001111",
    group: false,
    pushName: "Stranger",
    isFromMe: false,
    sock: { sendMessage: sendMessageMock },
    remoteJid: "15550001111@s.whatsapp.net",
  });
}

function expectSilentlyBlocked(result: { allowed: boolean }) {
  expect(result.allowed).toBe(false);
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}

async function checkCommandAuthorizedForDm(params: {
  cfg: Record<string, unknown>;
  accountId?: string;
  from?: string;
  senderE164?: string;
  selfE164?: string;
}) {
  return await resolveWhatsAppCommandAuthorized({
    cfg: params.cfg as never,
    msg: createTestWebInboundMessage({
      event: { id: "cmd-dm" },
      payload: { body: "/status" },
      platform: {
        chatJid: params.from ?? "+15550001111",
        recipientJid: params.selfE164 ?? "+15550009999",
        senderE164: params.senderE164 ?? params.from ?? "+15550001111",
        selfE164: params.selfE164 ?? "+15550009999",
      },
      admission: {
        accountId: params.accountId ?? "work",
        conversation: {
          kind: "direct",
          id: params.from ?? "+15550001111",
        },
        sender: {
          id: params.senderE164 ?? params.from ?? "+15550001111",
        },
      },
    }) as never,
  });
}

async function checkCommandAuthorizedForGroup(params: {
  cfg: Record<string, unknown>;
  accountId?: string;
  from?: string;
  senderE164?: string;
  selfE164?: string;
}) {
  return await resolveWhatsAppCommandAuthorized({
    cfg: params.cfg as never,
    msg: createTestWebInboundMessage({
      event: { id: "cmd-group" },
      payload: { body: "/status" },
      platform: {
        chatJid: params.from ?? "120363401234567890@g.us",
        recipientJid: params.selfE164 ?? "+15550009999",
        senderE164: params.senderE164 ?? "+15550001111",
        selfE164: params.selfE164 ?? "+15550009999",
      },
      admission: {
        accountId: params.accountId ?? "work",
        conversation: {
          kind: "group",
          id: params.from ?? "120363401234567890@g.us",
        },
        sender: {
          id: params.senderE164 ?? "+15550001111",
        },
        senderAccess: {
          reasonCode: "group_policy_allowed",
        },
      },
    }) as never,
  });
}

describe("checkInboundAccessControl admission contract", () => {
  it("does not authorize unresolved group participant JIDs as phone allowlist entries", async () => {
    const groupJid = "120363401234567890@g.us";
    const cfg = {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkAccess({
      from: groupJid,
      senderE164: null,
      senderJid: "15550001111@lid",
      group: true,
      remoteJid: groupJid,
    });

    expect(result.allowed).toBe(false);
    expect("admission" in result).toBe(false);
  });
});

describe("checkInboundAccessControl pairing grace", () => {
  async function runPairingGraceCase(messageTimestampMs: number) {
    const connectedAtMs = 1_000_000;
    return await checkAccess({
      messageTimestampMs,
      connectedAtMs,
    });
  }

  it("suppresses pairing replies for historical DMs on connect", async () => {
    const result = await runPairingGraceCase(1_000_000 - 31_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends pairing replies for live DMs", async () => {
    const result = await runPairingGraceCase(1_000_000 - 10_000);

    expect(result.allowed).toBe(false);
    expect(result.isSelfChat).toBe(false);
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe("WhatsApp dmPolicy precedence", () => {
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    // Channel-level says "pairing" but the account-level says "allowlist".
    // The account-level override should take precedence, so an unauthorized
    // sender should be blocked silently (no pairing reply).
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });
    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
  });

  it("does not merge persisted pairing approvals in allowlist mode", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);
    readAllowFromStoreMock.mockResolvedValue(["+15550001111"]);

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it.each([{ name: "enabled", selfChatMode: true }])(
    "allows same-phone fromMe DMs when self-chat mode is $name",
    async ({ selfChatMode }) => {
      const cfg = {
        channels: {
          whatsapp: {
            dmPolicy: "pairing",
            allowFrom: ["+15550001111"],
            ...(selfChatMode === undefined ? {} : { selfChatMode }),
          },
        },
      };
      setAccessControlTestConfig(cfg);

      const result = await checkAccess({
        from: "+15550009999",
        senderE164: "+15550009999",
        pushName: "Owner",
        isFromMe: true,
        remoteJid: "15550009999@s.whatsapp.net",
      });
      const commandAuthorized = await checkCommandAuthorizedForDm({
        cfg,
        accountId: "default",
        from: "+15550009999",
        senderE164: "+15550009999",
        selfE164: "+15550009999",
      });

      expect(result.allowed).toBe(true);
      expect(commandAuthorized).toBe(true);
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "a named account overriding enabled channel self-chat",
      accountId: "work",
      whatsapp: {
        dmPolicy: "pairing",
        selfChatMode: true,
        accounts: {
          work: {
            allowFrom: ["+15550009999"],
            selfChatMode: false,
          },
        },
      },
    },
  ])("blocks allowlisted same-phone fromMe DMs for $name", async ({ accountId, whatsapp }) => {
    setAccessControlTestConfig({ channels: { whatsapp } });

    const result = await checkAccess({
      accountId,
      from: "+15550009999",
      senderE164: "+15550009999",
      pushName: "Owner",
      isFromMe: true,
      remoteJid: "15550009999@s.whatsapp.net",
    });

    expectSilentlyBlocked(result);
    expect(result.shouldMarkRead).toBe(false);
    expect(result.isSelfChat).toBe(false);
    expect(result.resolvedAccountId).toBe(accountId);
  });

  it("does not implicitly allow the linked phone when self-chat is disabled", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550001111"],
          selfChatMode: false,
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkAccess({
      from: "+15550009999",
      senderE164: "+15550009999",
      pushName: "Owner",
      remoteJid: "15550009999@s.whatsapp.net",
    });
    const commandAuthorized = await checkCommandAuthorizedForDm({
      cfg,
      accountId: "default",
      from: "+15550009999",
      senderE164: "+15550009999",
      selfE164: "+15550009999",
    });

    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
  });

  it("does not grant group command ownership through implicit linked-phone access", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          groupPolicy: "open",
          allowFrom: ["+15550001111"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    expect(
      await checkCommandAuthorizedForGroup({
        cfg,
        accountId: "default",
        senderE164: "+15550009999",
        selfE164: "+15550009999",
      }),
    ).toBe(false);
  });

  it("allows DMs from generic message sender access groups", async () => {
    const cfg = {
      accessGroups: {
        owners: {
          type: "message.senders",
          members: {
            whatsapp: ["+15550001111"],
          },
        },
      },
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          accounts: {
            work: {
              allowFrom: ["accessGroup:owners"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkAccess({
      accountId: "work",
    });
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("allows group messages from generic message sender access groups", async () => {
    const cfg = {
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            whatsapp: ["+15550001111"],
          },
        },
      },
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          groupAllowFrom: ["accessGroup:operators"],
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkAccess({
      accountId: "work",
      from: "120363401234567890@g.us",
      group: true,
      remoteJid: "120363401234567890@g.us",
    });
    const commandAuthorized = await checkCommandAuthorizedForGroup({ cfg });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("falls back from empty groupAllowFrom to allowFrom for group allowlists", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          groupAllowFrom: [],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkAccess({
      from: "120363401234567890@g.us",
      group: true,
      remoteJid: "120363401234567890@g.us",
    });
    const commandAuthorized = await checkCommandAuthorizedForGroup({
      cfg,
      accountId: "default",
    });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("authorizes group commands when owner sender is a LID JID with authDir (issue #77755)", async () => {
    const lidDigits = "9876543210";
    const ownerE164 = "+15550001111";
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-77755-"));
    try {
      // Write reverse LID mapping so the LID JID resolves to the owner's phone
      fs.writeFileSync(
        path.join(authDir, `lid-mapping-${lidDigits}_reverse.json`),
        JSON.stringify(ownerE164),
      );

      const cfg = {
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: [ownerE164],
          },
        },
      };
      setAccessControlTestConfig(cfg);

      const result = await resolveWhatsAppCommandAuthorized({
        cfg: cfg as never,
        msg: createTestWebInboundMessage({
          event: { id: "cmd-group-lid" },
          payload: { body: "/status" },
          platform: {
            chatJid: "120363401234567890@g.us",
            recipientJid: "+15550009999",
            senderJid: `${lidDigits}@lid`,
            selfE164: "+15550009999",
          },
          admission: {
            conversation: {
              id: "120363401234567890@g.us",
              kind: "group",
            },
          },
        }) as never,
        authDir,
      });

      expect(result).toBe(true);
    } finally {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("treats same-phone DMs as self-chat only when explicitly configured", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550009999"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkAccess({
      from: "+15550009999",
      senderE164: "+15550009999",
      pushName: "Owner",
      remoteJid: "15550009999@s.whatsapp.net",
    });

    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
  });
});
