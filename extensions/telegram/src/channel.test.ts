import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
  ResolvedTelegramAccount,
} from "openclaw/plugin-sdk/telegram";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramRuntime } from "./runtime.js";

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

function createStartAccountCtx(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: ReturnType<typeof createRuntimeEnv>;
}): ChannelGatewayContext<ResolvedTelegramAccount> {
  const account = telegramPlugin.config.resolveAccount(
    params.cfg,
    params.accountId,
  ) as ResolvedTelegramAccount;
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.accountId,
    configured: true,
    enabled: true,
    running: false,
  };
  return {
    accountId: params.accountId,
    account,
    cfg: params.cfg,
    runtime: params.runtime,
    abortSignal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: vi.fn(),
  };
}

function installGatewayRuntime(params?: { probeOk?: boolean; botUsername?: string }) {
  const monitorTelegramProvider = vi.fn(async () => undefined);
  const probeTelegram = vi.fn(async () =>
    params?.probeOk ? { ok: true, bot: { username: params.botUsername ?? "bot" } } : { ok: false },
  );
  const collectUnmentionedGroupIds = vi.fn(() => ({
    groupIds: [] as string[],
    unresolvedGroups: 0,
    hasWildcardUnmentionedGroups: false,
  }));
  const auditGroupMembership = vi.fn(async () => ({
    ok: true,
    checkedGroups: 0,
    unresolvedGroups: 0,
    hasWildcardUnmentionedGroups: false,
    groups: [],
    elapsedMs: 0,
  }));
  setTelegramRuntime({
    channel: {
      telegram: {
        monitorTelegramProvider,
        probeTelegram,
        collectUnmentionedGroupIds,
        auditGroupMembership,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
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

function installSendMessageRuntime(
  sendMessageTelegram: ReturnType<typeof vi.fn>,
): ReturnType<typeof vi.fn> {
  setTelegramRuntime({
    channel: {
      telegram: {
        sendMessageTelegram,
      },
    },
  } as unknown as PluginRuntime);
  return sendMessageTelegram;
}

describe("telegramPlugin duplicate token guard", () => {
  it("marks secondary account as not configured when token is shared", async () => {
    const cfg = createCfg();
    const alertsAccount = telegramPlugin.config.resolveAccount(cfg, "alerts");
    const workAccount = telegramPlugin.config.resolveAccount(cfg, "work");
    const opsAccount = telegramPlugin.config.resolveAccount(cfg, "ops");

    expect(await telegramPlugin.config.isConfigured!(alertsAccount, cfg)).toBe(true);
    expect(await telegramPlugin.config.isConfigured!(workAccount, cfg)).toBe(false);
    expect(await telegramPlugin.config.isConfigured!(opsAccount, cfg)).toBe(true);

    expect(telegramPlugin.config.unconfiguredReason?.(workAccount, cfg)).toContain(
      'account "alerts"',
    );
  });

  it("surfaces duplicate-token reason in status snapshot", async () => {
    const cfg = createCfg();
    const workAccount = telegramPlugin.config.resolveAccount(cfg, "work");
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
    const { monitorTelegramProvider, probeTelegram } = installGatewayRuntime({ probeOk: true });

    await expect(
      telegramPlugin.gateway!.startAccount!(
        createStartAccountCtx({
          cfg: createCfg(),
          accountId: "work",
          runtime: createRuntimeEnv(),
        }),
      ),
    ).rejects.toThrow("Duplicate Telegram bot token");

    expect(probeTelegram).not.toHaveBeenCalled();
    expect(monitorTelegramProvider).not.toHaveBeenCalled();
  });

  it("passes webhookPort through to monitor startup options", async () => {
    const { monitorTelegramProvider } = installGatewayRuntime({
      probeOk: true,
      botUsername: "opsbot",
    });

    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      webhookUrl: "https://example.test/telegram-webhook",
      webhookSecret: "secret", // pragma: allowlist secret
      webhookPort: 9876,
    };

    await telegramPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        cfg,
        accountId: "ops",
        runtime: createRuntimeEnv(),
      }),
    );

    expect(monitorTelegramProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebhook: true,
        webhookPort: 9876,
      }),
    );
  });

  it("passes account proxy and network settings into Telegram probes", async () => {
    const { probeTelegram } = installGatewayRuntime({
      probeOk: true,
      botUsername: "opsbot",
    });

    const cfg = createCfg();
    configureOpsProxyNetwork(cfg);
    const account = telegramPlugin.config.resolveAccount(cfg, "ops");

    await telegramPlugin.status!.probeAccount!({
      account,
      timeoutMs: 5000,
      cfg,
    });

    expect(probeTelegram).toHaveBeenCalledWith("token-ops", 5000, {
      accountId: "ops",
      proxyUrl: "http://127.0.0.1:8888",
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    });
  });

  it("passes account proxy and network settings into Telegram membership audits", async () => {
    const { collectUnmentionedGroupIds, auditGroupMembership } = installGatewayRuntime({
      probeOk: true,
      botUsername: "opsbot",
    });

    collectUnmentionedGroupIds.mockReturnValue({
      groupIds: ["-100123"],
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
    });

    const cfg = createCfg();
    configureOpsProxyNetwork(cfg);
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      groups: {
        "-100123": { requireMention: false },
      },
    };
    const account = telegramPlugin.config.resolveAccount(cfg, "ops");

    await telegramPlugin.status!.auditAccount!({
      account,
      timeoutMs: 5000,
      probe: { ok: true, bot: { id: 123 }, elapsedMs: 1 },
      cfg,
    });

    expect(auditGroupMembership).toHaveBeenCalledWith({
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

  it("ignores accounts with missing tokens during duplicate-token checks", async () => {
    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {} as never;

    const alertsAccount = telegramPlugin.config.resolveAccount(cfg, "alerts");
    expect(await telegramPlugin.config.isConfigured!(alertsAccount, cfg)).toBe(true);
  });

  it("does not crash startup when a resolved account token is undefined", async () => {
    const { monitorTelegramProvider } = installGatewayRuntime({ probeOk: false });

    const cfg = createCfg();
    const ctx = createStartAccountCtx({
      cfg,
      accountId: "ops",
      runtime: createRuntimeEnv(),
    });
    ctx.account = {
      ...ctx.account,
      token: undefined as unknown as string,
    } as ResolvedTelegramAccount;

    await expect(telegramPlugin.gateway!.startAccount!(ctx)).resolves.toBeUndefined();
    expect(monitorTelegramProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "",
      }),
    );
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
