import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { telegramPlugin } from "./channel.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import { telegramGateway } from "./telegram-gateway.js";

const probeTelegramMock = vi.hoisted(() => vi.fn());
const monitorTelegramProviderMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeTelegram: probeTelegramMock,
}));

vi.mock("./monitor.js", () => ({
  monitorTelegramProvider: monitorTelegramProviderMock,
}));

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
  return telegramGateway.startAccount(createStartTelegramContext(cfg, accountId));
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
  monitorTelegramProviderMock.mockImplementation(async () => undefined);
  probeTelegramMock.mockImplementation(async () =>
    params?.probeOk
      ? { ok: true, bot: { username: params.botUsername ?? "bot" }, elapsedMs: 0 }
      : { ok: false, elapsedMs: 0 },
  );
  return {
    monitorTelegramProvider: monitorTelegramProviderMock,
    probeTelegram: probeTelegramMock,
  };
}

afterEach(() => {
  clearTelegramRuntime();
  vi.clearAllMocks();
});

describe("telegramGateway", () => {
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
      webhookSecret: "secret",
      webhookPort: 9876,
    };

    await startTelegramAccount(cfg, "ops");

    expect(probeTelegramMock).toHaveBeenCalledWith("token-ops", 2500, {
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
      apiRoot: undefined,
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

    await telegramGateway.startAccount(ctx);
    expect(probeTelegramMock).toHaveBeenCalledWith("", 2500, {
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
      apiRoot: undefined,
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
