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
import { normalizeTestWhatsAppMessage } from "./message-normalization.test-helper.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

setupAccessControlTestHarness();
let resolveWhatsAppCommandAuthorized: typeof import("../inbound-policy.js").resolveWhatsAppCommandAuthorized;

beforeAll(async () => {
  ({ resolveWhatsAppCommandAuthorized } = await import("../inbound-policy.js"));
});

async function checkAccess(
  overrides: Partial<Parameters<typeof normalizeTestWhatsAppMessage>[0]> = {},
) {
  const normalized = await normalizeTestWhatsAppMessage({
    cfg: getAccessControlTestConfig() as never,
    sendMessage: sendMessageMock,
    ...overrides,
  });
  return normalized?.access ?? null;
}

function configure(whatsapp: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const cfg = { ...extra, channels: { whatsapp } };
  setAccessControlTestConfig(cfg);
  return cfg;
}

function senderGroup(name: string) {
  return { [name]: { type: "message.senders", members: { whatsapp: ["+15550001111"] } } };
}

function expectNoPairing() {
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}

const samePhone = {
  from: "+15550009999",
  senderE164: "+15550009999",
  pushName: "Owner",
  remoteJid: "15550009999@s.whatsapp.net",
};

async function checkUnauthorizedWorkDmSender() {
  return checkAccess({ accountId: "work", pushName: "Stranger" });
}

function expectSilentlyBlocked(result: Awaited<ReturnType<typeof checkAccess>>) {
  expect(result).toBeNull();
  expectNoPairing();
}

async function checkCommandAuthorized(
  params: {
    cfg: Record<string, unknown>;
    accountId?: string;
    from?: string;
    senderE164?: string;
    selfE164?: string;
  },
  group = false,
) {
  const from = params.from ?? (group ? "120363401234567890@g.us" : "+15550001111");
  const sender = params.senderE164 ?? (group ? "+15550001111" : from);
  const self = params.selfE164 ?? "+15550009999";
  return resolveWhatsAppCommandAuthorized({
    cfg: params.cfg as never,
    msg: createTestWebInboundMessage({
      event: { id: group ? "cmd-group" : "cmd-dm" },
      payload: { body: "/status" },
      platform: { chatJid: from, recipientJid: self, senderE164: sender, selfE164: self },
      admission: {
        accountId: params.accountId ?? "work",
        conversation: { kind: group ? "group" : "direct", id: from },
        sender: { id: sender },
        ...(group ? { senderAccess: { reasonCode: "group_policy_allowed" } } : {}),
      },
    }) as never,
  });
}

const checkCommandAuthorizedForDm = (params: Parameters<typeof checkCommandAuthorized>[0]) =>
  checkCommandAuthorized(params);
const checkCommandAuthorizedForGroup = (params: Parameters<typeof checkCommandAuthorized>[0]) =>
  checkCommandAuthorized(params, true);

describe("WhatsApp inbound normalization admission contract", () => {
  it("does not authorize unresolved group participant JIDs as phone allowlist entries", async () => {
    const groupJid = "120363401234567890@g.us";
    configure({
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15550001111"],
    });

    const result = await checkAccess({
      from: groupJid,
      senderE164: null,
      senderJid: "15550001111@lid",
      group: true,
      remoteJid: groupJid,
    });

    expect(result).toBeNull();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });
});

describe("WhatsApp inbound normalization pairing grace", () => {
  async function runPairingGraceCase(messageTimestampMs: number) {
    const connectedAtMs = 1_000_000;
    return await checkAccess({
      messageTimestampMs,
      connectedAtMs,
    });
  }

  it("suppresses pairing replies for historical DMs on connect", async () => {
    const result = await runPairingGraceCase(1_000_000 - 31_000);

    expect(result).toBeNull();
    expectNoPairing();
  });

  it("sends pairing replies for live DMs", async () => {
    const result = await runPairingGraceCase(1_000_000 - 10_000);

    expect(result).toBeNull();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe("WhatsApp dmPolicy precedence", () => {
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    const cfg = configure({
      dmPolicy: "pairing",
      accounts: {
        work: {
          dmPolicy: "allowlist",
          allowFrom: ["+15559999999"],
        },
      },
    });

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });
    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
  });

  it("does not merge persisted pairing approvals in allowlist mode", async () => {
    const cfg = configure({
      dmPolicy: "allowlist",
      accounts: {
        work: {
          allowFrom: ["+15559999999"],
        },
      },
    });
    readAllowFromStoreMock.mockResolvedValue(["+15550001111"]);

    const result = await checkUnauthorizedWorkDmSender();
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expectSilentlyBlocked(result);
    expect(commandAuthorized).toBe(false);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("allows same-phone fromMe DMs when self-chat mode is enabled", async () => {
    const cfg = configure({
      dmPolicy: "pairing",
      allowFrom: ["+15550001111"],
      selfChatMode: true,
    });
    expect(await checkAccess({ ...samePhone, isFromMe: true })).not.toBeNull();
    expect(
      await checkCommandAuthorizedForDm({
        cfg,
        accountId: "default",
        ...samePhone,
        selfE164: samePhone.from,
      }),
    ).toBe(true);
    expectNoPairing();
  });

  it("blocks allowlisted same-phone fromMe DMs for an account overriding channel self-chat", async () => {
    configure({
      dmPolicy: "pairing",
      selfChatMode: true,
      accounts: { work: { allowFrom: ["+15550009999"], selfChatMode: false } },
    });
    expectSilentlyBlocked(await checkAccess({ accountId: "work", ...samePhone, isFromMe: true }));
  });

  it("does not implicitly allow the linked phone when self-chat is disabled", async () => {
    const cfg = configure({
      dmPolicy: "pairing",
      allowFrom: ["+15550001111"],
      selfChatMode: false,
    });

    const result = await checkAccess(samePhone);
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
    const cfg = configure({
      dmPolicy: "pairing",
      groupPolicy: "open",
      allowFrom: ["+15550001111"],
    });

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
    const cfg = configure(
      {
        dmPolicy: "allowlist",
        accounts: {
          work: {
            allowFrom: ["accessGroup:owners"],
          },
        },
      },
      { accessGroups: senderGroup("owners") },
    );

    const result = await checkAccess({
      accountId: "work",
    });
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expect(result).not.toBeNull();
    expect(commandAuthorized).toBe(true);
    expectNoPairing();
  });

  it("allows group messages from generic message sender access groups", async () => {
    const cfg = configure(
      {
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        accounts: {
          work: {
            allowFrom: ["+15559999999"],
          },
        },
      },
      { accessGroups: senderGroup("operators") },
    );

    const result = await checkAccess({
      accountId: "work",
      from: "120363401234567890@g.us",
      group: true,
      remoteJid: "120363401234567890@g.us",
    });
    const commandAuthorized = await checkCommandAuthorizedForGroup({ cfg });

    expect(result).not.toBeNull();
    expect(commandAuthorized).toBe(true);
    expectNoPairing();
  });

  it("falls back from empty groupAllowFrom to allowFrom for group allowlists", async () => {
    const cfg = configure({
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: ["+15550001111"],
      groupAllowFrom: [],
    });

    const result = await checkAccess({
      from: "120363401234567890@g.us",
      group: true,
      remoteJid: "120363401234567890@g.us",
    });
    const commandAuthorized = await checkCommandAuthorizedForGroup({
      cfg,
      accountId: "default",
    });

    expect(result).not.toBeNull();
    expect(commandAuthorized).toBe(true);
    expectNoPairing();
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

      const cfg = configure({
        dmPolicy: "allowlist",
        allowFrom: [ownerE164],
      });

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
    configure({
      dmPolicy: "pairing",
      allowFrom: ["+15550009999"],
    });

    const result = await checkAccess(samePhone);

    expect(result).not.toBeNull();
    expect(result?.isSelfChat).toBe(true);
  });
});
