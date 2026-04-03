import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { telegramPlugin } from "./channel.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import { telegramStatus } from "./telegram-status.js";

const probeTelegramMock = vi.hoisted(() => vi.fn());
const collectTelegramUnmentionedGroupIdsMock = vi.hoisted(() => vi.fn());
const auditTelegramGroupMembershipMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeTelegram: probeTelegramMock,
}));

vi.mock("./audit.js", () => ({
  collectTelegramUnmentionedGroupIds: collectTelegramUnmentionedGroupIdsMock,
  auditTelegramGroupMembership: auditTelegramGroupMembershipMock,
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

function installTelegramRuntime(telegram?: Record<string, unknown>) {
  setTelegramRuntime({
    channel: telegram ? { telegram } : undefined,
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime);
}

afterEach(() => {
  clearTelegramRuntime();
  vi.clearAllMocks();
});

describe("telegramStatus", () => {
  it("surfaces duplicate-token reason in status snapshot", async () => {
    const cfg = createCfg();
    const workAccount = resolveAccount(cfg, "work");
    const snapshot = await telegramStatus.buildAccountSnapshot!({
      account: workAccount,
      cfg,
      runtime: undefined,
      probe: undefined,
      audit: undefined,
    });

    expect(snapshot.configured).toBe(false);
    expect(snapshot.lastError).toContain('account "alerts"');
  });

  it("falls back to direct probe helpers when Telegram runtime is uninitialized", async () => {
    probeTelegramMock.mockResolvedValue({
      ok: false,
      elapsedMs: 1,
    });
    const cfg = createCfg();
    const account = resolveAccount(cfg, "ops");

    await expect(
      telegramStatus.probeAccount!({
        account,
        timeoutMs: 1234,
        cfg,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: expect.any(Boolean),
        elapsedMs: expect.any(Number),
      }),
    );
  });

  it("prefers runtime Telegram probe helpers when runtime state is set", async () => {
    const runtimeProbeTelegram = vi.fn(async () => ({
      ok: true,
      bot: { username: "runtimebot" },
      elapsedMs: 7,
    }));
    probeTelegramMock.mockResolvedValue({
      ok: true,
      bot: { username: "modulebot" },
      elapsedMs: 1,
    });
    installTelegramRuntime({
      probeTelegram: runtimeProbeTelegram,
    });

    const cfg = createCfg();
    const account = resolveAccount(cfg, "ops");

    await expect(
      telegramStatus.probeAccount!({
        account,
        timeoutMs: 4321,
        cfg,
      }),
    ).resolves.toEqual({
      ok: true,
      bot: { username: "runtimebot" },
      elapsedMs: 7,
    });
    expect(runtimeProbeTelegram).toHaveBeenCalledWith("token-ops", 4321, {
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
      apiRoot: undefined,
    });
    expect(probeTelegramMock).not.toHaveBeenCalled();
  });

  it("passes account proxy and network settings into Telegram probes", async () => {
    probeTelegramMock.mockResolvedValue({
      ok: true,
      bot: { username: "opsbot" },
      elapsedMs: 1,
    });

    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      proxy: "http://127.0.0.1:8888",
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
    };
    const account = resolveAccount(cfg, "ops");

    await telegramStatus.probeAccount!({
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
      apiRoot: undefined,
    });
  });

  it("passes account proxy and network settings into Telegram membership audits", async () => {
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

    const cfg = createCfg();
    cfg.channels!.telegram!.accounts!.ops = {
      ...cfg.channels!.telegram!.accounts!.ops,
      proxy: "http://127.0.0.1:8888",
      network: {
        autoSelectFamily: false,
        dnsResultOrder: "ipv4first",
      },
      groups: {
        "-100123": { requireMention: false },
      },
    };
    const account = resolveAccount(cfg, "ops");

    await telegramStatus.auditAccount!({
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
      apiRoot: undefined,
      timeoutMs: 5000,
    });
  });
});
