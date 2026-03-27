import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { PluginApprovalRequest } from "../../../src/infra/plugin-approvals.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import * as auditModule from "./audit.js";
import { telegramPlugin } from "./channel.js";
import * as monitorModule from "./monitor.js";
import * as probeModule from "./probe.js";
import { setTelegramRuntime } from "./runtime.js";

const probeTelegramMock = vi.hoisted(() => vi.fn());
const collectTelegramUnmentionedGroupIdsMock = vi.hoisted(() => vi.fn());
const auditTelegramGroupMembershipMock = vi.hoisted(() => vi.fn());
const monitorTelegramProviderMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe.js")>();
  return {
    ...actual,
    probeTelegram: probeTelegramMock,
  };
});

vi.mock("./audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit.js")>();
  return {
    ...actual,
    collectTelegramUnmentionedGroupIds: collectTelegramUnmentionedGroupIdsMock,
    auditTelegramGroupMembership: auditTelegramGroupMembershipMock,
  };
});

vi.mock("./monitor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor.js")>();
  return {
    ...actual,
    monitorTelegramProvider: monitorTelegramProviderMock,
  };
});

function createCfg(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        enabled: true,
        accounts: {
          alerts: { botToken: "token-shared" },
          work: { botToken: "token-shared" },
          ops: { botToken: "token-ops" },
        },
      },
    },
  } as OpenClawConfig;
}

function resolveAccount(cfg: OpenClawConfig, accountId: string): ResolvedTelegramAccount {
  return telegramPlugin.config.resolveAccount(cfg, accountId) as ResolvedTelegramAccount;
}

function createStartTelegramContext(cfg: OpenClawConfig, accountId: string) {
  return createStartAccountContext({
    account: resolveAccount(cfg, accountId),
    cfg,
  });
}

function startTelegramAccount(cfg: OpenClawConfig, accountId: string) {
  return telegramPlugin.gateway!.startAccount!(createStartTelegramContext(cfg, accountId));
}

function installTelegramRuntime(telegram?: Record<string, unknown>) {
  setTelegramRuntime({
    channel: telegram ? { telegram } : undefined,
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
}

function installGatewayRuntime(params?: { probeOk?: boolean; botUsername?: string }) {
  const monitorTelegramProvider = vi
    .spyOn(monitorModule, "monitorTelegramProvider")
    .mockImplementation(async () => undefined);
  const probeTelegram = vi
    .spyOn(probeModule, "probeTelegram")
    .mockImplementation(async () =>
      params?.probeOk
        ? { ok: true, bot: { username: params.botUsername ?? "bot" }, elapsedMs: 0 }
        : { ok: false, elapsedMs: 0 },
    );
  const collectUnmentionedGroupIds = vi
    .spyOn(auditModule, "collectTelegramUnmentionedGroupIds")
    .mockImplementation(() => ({
      groupIds: [] as string[],
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
    }));
  const auditGroupMembership = vi
    .spyOn(auditModule, "auditTelegramGroupMembership")
    .mockImplementation(async () => ({
      ok: true,
      checkedGroups: 0,
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
      groups: [],
      elapsedMs: 0,
    }));
  installTelegramRuntime();
  return {
    monitorTelegramProvider,
    probeTelegram,
    collectUnmentionedGroupIds,
    auditGroupMembership,
  };
}

function configureOpsProxyNetwork(cfg: OpenClawConfig) {
  cfg.channels!.telegram!.accounts!.ops = {
    ...cfg.channels!.telegram!.accounts!.ops,
    proxy: "http://127.0.0.1:8888",
    network: {
      autoSelectFamily: false,
      dnsResultOrder: "ipv4first",
    },
  };
}

function createOpsProxyAccount() {
  const cfg = createCfg();
  configureOpsProxyNetwork(cfg);
  return {
    cfg,
    account: resolveAccount(cfg, "ops"),
  };
}

function installSendMessageRuntime(
  sendMessageTelegram: ReturnType<typeof vi.fn>,
): ReturnType<typeof vi.fn> {
  installTelegramRuntime({
    sendMessageTelegram,
  });
  return sendMessageTelegram;
}

function createPluginApprovalRequest(
  overrides: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    id: "plugin:12345678-1234-1234-1234-1234567890ab",
    request: {
      title: "Sensitive plugin action",
      description: "The plugin requested a sensitive operation.",
      severity: "warning",
      toolName: "plugin.tool",
      pluginId: "plugin-test",
      agentId: "agent-main",
      sessionKey: "agent:agent-main:telegram:12345",
      ...overrides,
    },
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          groups: {
            "-1001": {
              requireMention: true,
              tools: { allow: ["message.send"] },
              topics: {
                "77": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      telegramPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupId: "-1001:topic:77",
      }),
    ).toBe(false);
    expect(
      telegramPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupId: "-1001:topic:77",
      }),
    ).toEqual({ allow: ["message.send"] });
  });
});

describe("telegramPlugin duplicate token guard", () => {
  it("marks secondary account as not configured when token is shared", async () => {
    const cfg = createCfg();
    const alertsAccount = resolveAccount(cfg, "alerts");
    const workAccount = resolveAccount(cfg, "work");
    const opsAccount = resolveAccount(cfg, "ops");

    expect(await telegramPlugin.config.isConfigured!(alertsAccount, cfg)).toBe(true);
    expect(await telegramPlugin.config.isConfigured!(workAccount, cfg)).toBe(false);
    expect(await telegramPlugin.config.isConfigured!(opsAccount, cfg)).toBe(true);

    expect(telegramPlugin.config.unconfiguredReason?.(workAccount, cfg)).toContain(
      'account "alerts"',
    );
  });

  it("surfaces duplicate-token reason in status snapshot", async () => {
    const cfg = createCfg();
    const workAccount = resolveAccount(cfg, "work");
    const snapshot = await telegramPlugin.status!.buildAccountSnapshot!({
      account: workAccount,
      cfg,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot.configured).toBe(false);
    expect(snapshot.lastError).toContain('account "alerts"');
  });

  it("blocks startup for duplicate token accounts before polling starts", async () => {
    const { monitorTelegramProvider, probeTelegram } = installGatewayRuntime({
      probeOk: true,
    });
    const cfg = createCfg();

    await expect(startTelegramAccount(cfg, "work")).rejects.toThrow("Duplicate Telegram bot token");

    expect(probeTelegramMock).not.toHaveBeenCalled();
    expect(monitorTelegramProviderMock).not.toHaveBeenCalled();
    expect(probeTelegram).not.toHaveBeenCalled();
    expect(monitorTelegramProvider).not.toHaveBeenCalled();
  });

  it("passes webhookPort through to monitor startup options", async () => {
    const { monitorTelegramProvider, probeTelegram } = installGatewayRuntime({
      probeOk: true,
      botUsername: "opsbot",
    });
    probeTelegramMock.mockResolvedValue({
      ok: true,
      bot: { username: "opsbot" },
      elapsedMs: 1,
    });
    monitorTelegramProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      webhookUrl: "https://example.test/telegram-webhook",
      webhookSecret: "secret", // pragma: allowlist secret
      webhookPort: 9876,
    };

    await startTelegramAccount(cfg, "ops");

    expect(probeTelegramMock).toHaveBeenCalledWith("token-ops", 2500, {
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
    });
    expect(monitorTelegramProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebhook: true,
        webhookPort: 9876,
      }),
    );
    expect(probeTelegram).toHaveBeenCalled();
    expect(monitorTelegramProvider).toHaveBeenCalled();
  });

  it("passes account proxy and network settings into Telegram probes", async () => {
    const runtimeProbeTelegram = vi.fn(async () => {
      throw new Error("runtime probe should not be used");
    });
    installTelegramRuntime({
      probeTelegram: runtimeProbeTelegram,
    });
    probeTelegramMock.mockResolvedValue({
      ok: true,
      bot: { username: "opsbot" },
      elapsedMs: 1,
    });

    const { cfg, account } = createOpsProxyAccount();

    await telegramPlugin.status!.probeAccount!({
      account,
      timeoutMs: 5000,
      cfg,
    });

    expect(probeTelegramMock).toHaveBeenCalledWith("token-ops", 5000, {
      accountId: "ops",
      proxyUrl: "http://127.0.0.1:8888",
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });
    expect(runtimeProbeTelegram).not.toHaveBeenCalled();
  });

  it("passes account proxy and network settings into Telegram membership audits", async () => {
    const runtimeCollectUnmentionedGroupIds = vi.fn(() => {
      throw new Error("runtime audit helper should not be used");
    });
    const runtimeAuditGroupMembership = vi.fn(async () => {
      throw new Error("runtime audit helper should not be used");
    });
    installTelegramRuntime({
      collectUnmentionedGroupIds: runtimeCollectUnmentionedGroupIds,
      auditGroupMembership: runtimeAuditGroupMembership,
    });
    collectTelegramUnmentionedGroupIdsMock.mockReturnValue({
      groupIds: ["-100123"],
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
    });
    auditTelegramGroupMembershipMock.mockResolvedValue({
      ok: true,
      checkedGroups: 1,
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
      groups: [],
      elapsedMs: 1,
    });

    const { cfg, account } = createOpsProxyAccount();
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      groups: {
        "-100123": { requireMention: false },
      },
    };

    await telegramPlugin.status!.auditAccount!({
      account,
      timeoutMs: 5000,
      probe: { ok: true, bot: { id: 123 }, elapsedMs: 1 },
      cfg,
    });

    expect(collectTelegramUnmentionedGroupIdsMock).toHaveBeenCalledWith({
      "-100123": { requireMention: false },
    });
    expect(auditTelegramGroupMembershipMock).toHaveBeenCalledWith({
      token: "token-ops",
      botId: 123,
      groupIds: ["-100123"],
      proxyUrl: "http://127.0.0.1:8888",
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
      timeoutMs: 5000,
    });
    expect(runtimeCollectUnmentionedGroupIds).not.toHaveBeenCalled();
    expect(runtimeAuditGroupMembership).not.toHaveBeenCalled();
  });

  it("forwards mediaLocalRoots to sendMessageTelegram for outbound media sends", async () => {
    const sendMessageTelegram = installSendMessageRuntime(
      vi.fn(async () => ({ messageId: "tg-1" })),
    );

    const result = await telegramPlugin.outbound!.sendMedia!({
      cfg: createCfg(),
      to: "12345",
      text: "hello",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "ops",
    });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
    expect(result).toMatchObject({ channel: "telegram", messageId: "tg-1" });
  });

  it("preserves buttons for outbound text payload sends", async () => {
    const sendMessageTelegram = installSendMessageRuntime(
      vi.fn(async () => ({ messageId: "tg-2" })),
    );

    const result = await telegramPlugin.outbound!.sendPayload!({
      cfg: createCfg(),
      to: "12345",
      text: "",
      payload: {
        text: "Approval required",
        channelData: {
          telegram: {
            buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
          },
        },
      },
      accountId: "ops",
    });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      "Approval required",
      expect.objectContaining({
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(result).toMatchObject({ channel: "telegram", messageId: "tg-2" });
  });

  it("sends outbound payload media lists and keeps buttons on the first message only", async () => {
    const sendMessageTelegram = installSendMessageRuntime(
      vi
        .fn()
        .mockResolvedValueOnce({ messageId: "tg-3", chatId: "12345" })
        .mockResolvedValueOnce({ messageId: "tg-4", chatId: "12345" }),
    );

    const result = await telegramPlugin.outbound!.sendPayload!({
      cfg: createCfg(),
      to: "12345",
      text: "",
      payload: {
        text: "Approval required",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
        channelData: {
          telegram: {
            quoteText: "quoted",
            buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
          },
        },
      },
      mediaLocalRoots: ["/tmp/media"],
      accountId: "ops",
      silent: true,
    });

    expect(sendMessageTelegram).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegram).toHaveBeenNthCalledWith(
      1,
      "12345",
      "Approval required",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        silent: true,
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(sendMessageTelegram).toHaveBeenNthCalledWith(
      2,
      "12345",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        silent: true,
      }),
    );
    expect(
      (sendMessageTelegram.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons,
    ).toBeUndefined();
    expect(result).toMatchObject({ channel: "telegram", messageId: "tg-4" });
  });

  it("builds plugin approval pending payload with callback ids that preserve allow-always", () => {
    const request = createPluginApprovalRequest();
    const payload = telegramPlugin.execApprovals?.buildPluginPendingPayload?.({
      cfg: createCfg(),
      request,
      target: { channel: "telegram", to: "12345" },
      nowMs: 2_000,
    });

    expect(payload?.text).toContain("Plugin approval required");
    const channelData = payload?.channelData as
      | {
          execApproval?: { approvalId?: string; approvalSlug?: string };
          telegram?: { buttons?: Array<Array<{ text: string; callback_data: string }>> };
        }
      | undefined;
    expect(channelData?.execApproval?.approvalId).toBe(request.id);
    expect(channelData?.execApproval?.approvalSlug).toBe(request.id);
    const buttons = channelData?.telegram?.buttons;
    expect(buttons).toBeDefined();
    expect(buttons?.[0]?.some((button) => button.text === "Allow Always")).toBe(true);
    for (const row of buttons ?? []) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });

  it("ignores accounts with missing tokens during duplicate-token checks", async () => {
    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {} as never;

    const alertsAccount = resolveAccount(cfg, "alerts");
    expect(await telegramPlugin.config.isConfigured!(alertsAccount, cfg)).toBe(true);
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  // Single-bot setup with channel-level token should report configured.
  it("reports configured for single-bot setup with channel-level token", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "single-bot-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const account = resolveAccount(cfg, "default");
    expect(await telegramPlugin.config.isConfigured!(account, cfg)).toBe(true);
  });

  // Regression: https://github.com/openclaw/openclaw/issues/53876
  // Binding-created non-default accountId in single-bot setup should report configured.
  it("reports configured for binding-created accountId in single-bot setup", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "single-bot-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const account = resolveAccount(cfg, "bot-main");
    expect(account.token).toBe("single-bot-token");
    expect(await telegramPlugin.config.isConfigured!(account, cfg)).toBe(true);
  });

  // Regression: multi-bot guard — unknown binding-created accountId in multi-bot
  // setup must NOT be reported as configured, matching resolveTelegramToken behaviour.
  it("reports not configured for unknown binding-created accountId in multi-bot setup", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "channel-level-token",
          enabled: true,
          accounts: {
            knownBot: { botToken: "known-bot-token" },
          },
        },
      },
    } as OpenClawConfig;

    const account = resolveAccount(cfg, "unknownBot");
    expect(await telegramPlugin.config.isConfigured!(account, cfg)).toBe(false);
    expect(telegramPlugin.config.unconfiguredReason?.(account, cfg)).toContain("unknown accountId");
  });

  // Regression: multi-bot guard must use full normalization (same as resolveTelegramToken)
  // so that account keys like "Carey Notifications" resolve to "carey-notifications".
  it("multi-bot guard normalizes account keys with spaces and mixed case", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "channel-level-token",
          enabled: true,
          accounts: {
            "Carey Notifications": { botToken: "carey-token" },
          },
        },
      },
    } as OpenClawConfig;

    // "carey-notifications" is the normalized form of "Carey Notifications"
    const account = resolveAccount(cfg, "carey-notifications");
    expect(await telegramPlugin.config.isConfigured!(account, cfg)).toBe(true);
  });

  // Regression: configured_unavailable token (e.g. unreadable tokenFile) should
  // NOT be reported as configured — runtime would fail to authenticate.
  it("reports not configured when token is configured_unavailable", async () => {
    const cfg = {
      channels: {
        telegram: {
          tokenFile: "/nonexistent/path/to/token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const account = resolveAccount(cfg, "default");
    // tokenFile is configured but file doesn't exist → configured_unavailable
    expect(await telegramPlugin.config.isConfigured!(account, cfg)).toBe(false);
    expect(telegramPlugin.config.unconfiguredReason?.(account, cfg)).toContain("unavailable");
  });

  it("does not crash startup when a resolved account token is undefined", async () => {
    const { monitorTelegramProvider, probeTelegram } = installGatewayRuntime({
      probeOk: false,
    });
    probeTelegramMock.mockResolvedValue({ ok: false, elapsedMs: 1 });
    monitorTelegramProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    const ctx = createStartTelegramContext(cfg, "ops");
    ctx.account = {
      ...ctx.account,
      token: undefined as unknown as string,
    } as ResolvedTelegramAccount;

    await expect(telegramPlugin.gateway!.startAccount!(ctx)).resolves.toBeUndefined();
    expect(probeTelegramMock).toHaveBeenCalledWith("", 2500, {
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
    });
    expect(monitorTelegramProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "",
      }),
    );
    expect(probeTelegram).toHaveBeenCalled();
    expect(monitorTelegramProvider).toHaveBeenCalled();
  });
});

describe("telegramPlugin outbound sendPayload forceDocument", () => {
  it("forwards forceDocument to the underlying send call when channelData is present", async () => {
    const sendMessageTelegram = installSendMessageRuntime(
      vi.fn(async () => ({ messageId: "tg-fd" })),
    );

    await telegramPlugin.outbound!.sendPayload!({
      cfg: createCfg(),
      to: "12345",
      text: "",
      payload: {
        text: "here is an image",
        mediaUrls: ["https://example.com/photo.png"],
        channelData: { telegram: {} },
      },
      accountId: "ops",
      forceDocument: true,
    });

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      expect.any(String),
      expect.objectContaining({ forceDocument: true }),
    );
  });
});
