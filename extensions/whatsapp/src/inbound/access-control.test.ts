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
let authorize: typeof import("../inbound-policy.js").resolveWhatsAppCommandAuthorized;
beforeAll(async () => {
  ({ resolveWhatsAppCommandAuthorized: authorize } = await import("../inbound-policy.js"));
});
const PHONE = "+15550001111";
const SELF = "+15550009999";
const GROUP = "120363401234567890@g.us";
const groupMessage = { from: GROUP, group: true, remoteJid: GROUP };
const samePhone = {
  from: SELF,
  senderE164: SELF,
  pushName: "Owner",
  remoteJid: "15550009999@s.whatsapp.net",
};
type Input = Partial<Parameters<typeof normalizeTestWhatsAppMessage>[0]>;

function configure(whatsapp: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  setAccessControlTestConfig({ ...extra, channels: { whatsapp } });
}
async function access(overrides: Input = {}) {
  const result = await normalizeTestWhatsAppMessage({
    cfg: getAccessControlTestConfig() as never,
    sendMessage: sendMessageMock,
    ...overrides,
  });
  return result?.access ?? null;
}
function command(input: Input = {}, group = false, authDir?: string) {
  const from = input.from ?? (group ? GROUP : PHONE);
  const sender = input.senderE164 ?? (group ? PHONE : from);
  const self = input.selfE164 ?? SELF;
  return authorize({
    cfg: getAccessControlTestConfig() as never,
    authDir,
    msg: createTestWebInboundMessage({
      event: { id: group ? "cmd-group" : "cmd-dm" },
      payload: { body: "/status" },
      platform: {
        chatJid: from,
        recipientJid: self,
        senderE164: sender,
        selfE164: self,
        ...(input.senderJid ? { senderJid: input.senderJid, senderE164: undefined } : {}),
      },
      admission: {
        accountId: input.accountId ?? "work",
        conversation: { kind: group ? "group" : "direct", id: from },
        sender: { id: sender },
        ...(group ? { senderAccess: { reasonCode: "group_policy_allowed" } } : {}),
      },
    }) as never,
  });
}
function noPairing() {
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}
async function checkBoth(allowed: boolean, input: Input = {}, group = false) {
  expect(
    (await access({ accountId: "work", ...(group ? groupMessage : {}), ...input })) === null,
  ).toBe(!allowed);
  expect(await command(input, group)).toBe(allowed);
  noPairing();
}

describe("WhatsApp admission and command authorization", () => {
  it("does not authorize unresolved group LIDs as phone allowlist entries", async () => {
    configure({ groupPolicy: "allowlist", groupAllowFrom: [PHONE] });
    expect(
      await access({ ...groupMessage, senderE164: null, senderJid: "15550001111@lid" }),
    ).toBeNull();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });
  it.each([
    ["historical", 31_000, false],
    ["live", 10_000, true],
  ] as const)("pairs only live DMs: %s", async (_name, age, pairs) => {
    expect(
      await access({ messageTimestampMs: 1_000_000 - age, connectedAtMs: 1_000_000 }),
    ).toBeNull();
    if (pairs) {
      expect(upsertPairingRequestMock).toHaveBeenCalled();
      expect(sendMessageMock).toHaveBeenCalled();
    } else {
      noPairing();
    }
  });
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    configure({
      dmPolicy: "pairing",
      accounts: { work: { dmPolicy: "allowlist", allowFrom: ["+15559999999"] } },
    });
    await checkBoth(false);
  });
  it("does not merge persisted pairing approvals in allowlist mode", async () => {
    configure({ dmPolicy: "allowlist", accounts: { work: { allowFrom: ["+15559999999"] } } });
    readAllowFromStoreMock.mockResolvedValue([PHONE]);
    await checkBoth(false);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "requires enabled self-chat for implicit same-phone access: %s",
    async (enabled) => {
      configure({ dmPolicy: "pairing", allowFrom: [PHONE], selfChatMode: enabled });
      await checkBoth(enabled, {
        ...samePhone,
        accountId: "default",
        selfE164: SELF,
        isFromMe: enabled,
      });
    },
  );
  it("honors an account overriding channel self-chat", async () => {
    configure({
      dmPolicy: "pairing",
      selfChatMode: true,
      accounts: { work: { allowFrom: [SELF], selfChatMode: false } },
    });
    expect(await access({ accountId: "work", ...samePhone, isFromMe: true })).toBeNull();
    noPairing();
  });
  it("does not grant group command ownership through implicit linked-phone access", async () => {
    configure({ dmPolicy: "pairing", groupPolicy: "open", allowFrom: [PHONE] });
    expect(await command({ accountId: "default", senderE164: SELF, selfE164: SELF }, true)).toBe(
      false,
    );
  });
  it.each([false, true])("allows generic sender access groups (group: %s)", async (group) => {
    configure(
      {
        dmPolicy: "allowlist",
        ...(group ? { groupPolicy: "allowlist", groupAllowFrom: ["accessGroup:owners"] } : {}),
        accounts: { work: { allowFrom: group ? ["+15559999999"] : ["accessGroup:owners"] } },
      },
      { accessGroups: { owners: { type: "message.senders", members: { whatsapp: [PHONE] } } } },
    );
    await checkBoth(true, {}, group);
  });
  it("falls back from empty groupAllowFrom to allowFrom", async () => {
    configure({
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      allowFrom: [PHONE],
      groupAllowFrom: [],
    });
    await checkBoth(true, { accountId: "default" }, true);
  });
  it("resolves owner LIDs via authDir for group commands (#77755)", async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-77755-"));
    try {
      fs.writeFileSync(
        path.join(authDir, "lid-mapping-9876543210_reverse.json"),
        JSON.stringify(PHONE),
      );
      configure({ dmPolicy: "allowlist", allowFrom: [PHONE] });
      expect(
        await command({ accountId: "default", senderJid: "9876543210@lid" }, true, authDir),
      ).toBe(true);
    } finally {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });
  it("recognizes same-phone DMs when explicitly allowlisted", async () => {
    configure({ dmPolicy: "pairing", allowFrom: [SELF] });
    expect(await access(samePhone)).toMatchObject({ isSelfChat: true });
  });
});
