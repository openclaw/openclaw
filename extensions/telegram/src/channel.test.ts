import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  OpenClawConfig,
  PluginRuntime,
  ResolvedTelegramAccount,
} from "openclaw/plugin-sdk";
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
    const monitorTelegramProvider = vi.fn(async () => undefined);
    const probeTelegram = vi.fn(async () => ({ ok: true, bot: { username: "bot" } }));
    const runtime = {
      channel: {
        telegram: {
          monitorTelegramProvider,
          probeTelegram,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime;
    setTelegramRuntime(runtime);

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
    const monitorTelegramProvider = vi.fn(async () => undefined);
    const probeTelegram = vi.fn(async () => ({ ok: true, bot: { username: "opsbot" } }));
    const runtime = {
      channel: {
        telegram: {
          monitorTelegramProvider,
          probeTelegram,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime;
    setTelegramRuntime(runtime);

    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      webhookUrl: "https://example.test/telegram-webhook",
      webhookSecret: "secret",
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

  it("forwards mediaLocalRoots to sendMessageTelegram for outbound media sends", async () => {
    const sendMessageTelegram = vi.fn(async () => ({ messageId: "tg-1" }));
    setTelegramRuntime({
      channel: {
        telegram: {
          sendMessageTelegram,
        },
      },
    } as unknown as PluginRuntime);

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
});
