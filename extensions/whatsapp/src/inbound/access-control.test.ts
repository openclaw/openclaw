// Whatsapp tests cover access control plugin behavior.
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readAllowFromStoreMock,
  sendMessageMock,
  getAccessControlTestConfig,
  runMessagePreAuthMock,
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

afterEach(() => {
  clearInternalHooks();
});

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

async function flushPreAuthHooks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
      accountId: params.accountId ?? "work",
      chatType: "direct",
      from: params.from ?? "+15550001111",
      conversationId: params.from ?? "+15550001111",
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
      accountId: params.accountId ?? "work",
      chatType: "group",
      from: params.from ?? "120363401234567890@g.us",
      conversationId: params.from ?? "120363401234567890@g.us",
    }) as never,
  });
}

describe("checkInboundAccessControl pairing grace", () => {
  async function runPairingGraceCase(messageTimestampMs: number) {
    const connectedAtMs = 1_000_000;
    return await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      messageTimestampMs,
      connectedAtMs,
      pairingGraceMs: 30_000,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "sender@s.whatsapp.net",
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

  it("emits pre-auth hooks for silently blocked allowlist DMs", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15559999999"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      content: "Let me in",
      group: false,
      pushName: "Requester",
      isFromMe: false,
      messageId: "msg-1",
      messagePreAuthHookRunner: {
        hasHooks: (hookName) => hookName === "message_pre_auth",
        runMessagePreAuth: runMessagePreAuthMock as never,
      },
      sock: { sendMessage: sendMessageMock },
      remoteJid: "sender@s.whatsapp.net",
    });
    await flushPreAuthHooks();

    expectSilentlyBlocked(result);
    expect(runMessagePreAuthMock).toHaveBeenCalledTimes(1);
    expect(runMessagePreAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "whatsapp",
        senderId: "+15550001111",
        senderName: "Requester",
        content: "Let me in",
        accountId: "default",
        conversationId: "+15550001111",
        messageId: "msg-1",
      }),
      expect.objectContaining({
        channelId: "whatsapp",
        senderId: "+15550001111",
      }),
    );
  });

  it("does not emit pre-auth hooks for allowlisted DMs", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      content: "hello",
      group: false,
      pushName: "Known",
      isFromMe: false,
      messagePreAuthHookRunner: {
        hasHooks: (hookName) => hookName === "message_pre_auth",
        runMessagePreAuth: runMessagePreAuthMock as never,
      },
      sock: { sendMessage: sendMessageMock },
      remoteJid: "sender@s.whatsapp.net",
    });
    await flushPreAuthHooks();

    expect(result.allowed).toBe(true);
    expect(runMessagePreAuthMock).not.toHaveBeenCalled();
  });

  it("does not emit pre-auth hooks for disabled DMs", async () => {
    const internalPreAuthHandler = vi.fn(async () => undefined);
    registerInternalHook("message:pre-auth", internalPreAuthHandler);
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "disabled",
          allowFrom: ["+15559999999"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      content: "Let me in",
      group: false,
      pushName: "Requester",
      isFromMe: false,
      messagePreAuthHookRunner: {
        hasHooks: (hookName) => hookName === "message_pre_auth",
        runMessagePreAuth: runMessagePreAuthMock as never,
      },
      sock: { sendMessage: sendMessageMock },
      remoteJid: "sender@s.whatsapp.net",
    });
    await flushPreAuthHooks();

    expectSilentlyBlocked(result);
    expect(runMessagePreAuthMock).not.toHaveBeenCalled();
    expect(internalPreAuthHandler).not.toHaveBeenCalled();
  });
  it("allows grouped allowFrom entries for DM allowlist access", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: [{ number: "+15550001111", group: "friends" }],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      content: "hello",
      group: false,
      pushName: "Known",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "sender@s.whatsapp.net",
    });
    const commandAuthorized = await checkCommandAuthorizedForDm({ cfg });

    expect(result.allowed).toBe(true);
    expect(commandAuthorized).toBe(true);
  });
  it("inherits channel-level dmPolicy when account-level dmPolicy is unset", async () => {
    // Account has allowFrom set, but no dmPolicy override. Should inherit the channel default.
    // With dmPolicy=allowlist, unauthorized senders are silently blocked.
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

  it("always allows same-phone DMs even when allowFrom is restrictive", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: ["+15550001111"],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Owner",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
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

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "work",
      from: "+15550001111",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: false,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550001111@s.whatsapp.net",
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

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "work",
      from: "120363401234567890@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
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

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "120363401234567890@g.us",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      group: true,
      pushName: "Sam",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
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

  it("does not broaden self-chat mode to every paired DM when allowFrom is empty", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    };
    setAccessControlTestConfig(cfg);

    const result = await checkInboundAccessControl({
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
    });

    expect(result.allowed).toBe(false);
    expect(result.isSelfChat).toBe(false);
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

    const result = await checkInboundAccessControl({
      cfg: getAccessControlTestConfig() as never,
      accountId: "default",
      from: "+15550009999",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      group: false,
      pushName: "Owner",
      isFromMe: false,
      sock: { sendMessage: sendMessageMock },
      remoteJid: "15550009999@s.whatsapp.net",
    });

    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
  });
});
