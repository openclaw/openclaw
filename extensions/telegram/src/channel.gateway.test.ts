import path from "node:path";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { readCachedTelegramBotInfo, writeCachedTelegramBotInfo } from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";
import { telegramPlugin } from "./channel.js";
import { acquireTelegramPollingLease } from "./polling-lease.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramPollingLeasesForTest as resetTelegramPollingLeasesForTests,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { withTelegramStartupProbeSlot } from "./startup-probe-limiter.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";

const { probeTelegram, monitorTelegramProvider } = vi.hoisted(() => ({
  probeTelegram: vi.fn(),
  monitorTelegramProvider: vi.fn(),
}));
vi.mock(import("./probe.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  probeTelegram,
}));
vi.mock(import("./monitor.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  monitorTelegramProvider,
}));
let testState: OpenClawTestState;

const startupBotInfo: TelegramBotInfo = {
  id: 123456,
  is_bot: true,
  first_name: "OpenClaw",
  username: "openclaw_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  can_manage_bots: false,
  supports_inline_queries: false,
  supports_join_request_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

function installTelegramRuntime() {
  const runtime: TelegramRuntime = createPluginRuntimeMock({
    state: {
      openKeyedStore: <T>(options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0]) =>
        createPluginStateKeyedStoreForTests<T>("telegram", { ...options, env: testState.env }),
    },
  });
  setTelegramRuntime(runtime);
  return runtime;
}

function createTelegramConfig(
  accountId = "default",
  telegramOverrides: Record<string, unknown> = {},
): OpenClawConfig {
  const account = { botToken: "123456:bad-token", ...telegramOverrides };
  return {
    channels: {
      telegram: accountId === "default" ? account : { accounts: { [accountId]: account } },
    },
  } as OpenClawConfig;
}

function accountContext(cfg: OpenClawConfig, accountId = "default", abortSignal?: AbortSignal) {
  return createStartAccountContext({
    account: telegramPlugin.config.resolveAccount(cfg, accountId),
    cfg,
    ...(abortSignal ? { abortSignal } : {}),
  });
}

function startAccount(ctx: ReturnType<typeof accountContext>) {
  return telegramPlugin.gateway!.startAccount!(ctx);
}

function startTelegramAccount(
  accountId = "default",
  telegramOverrides: Record<string, unknown> = {},
  abortSignal?: AbortSignal,
) {
  const ctx = accountContext(
    createTelegramConfig(accountId, telegramOverrides),
    accountId,
    abortSignal,
  );
  return { ctx, task: startAccount(ctx) };
}

const cachedAccount = { accountId: "ops", botToken: "123456:bad-token" };
const cacheBotInfo = (botToken = cachedAccount.botToken) =>
  writeCachedTelegramBotInfo({ ...cachedAccount, botToken, botInfo: startupBotInfo });
const expectEmptyBotInfo = () =>
  expect(readCachedTelegramBotInfo(cachedAccount)).resolves.toBeNull();
function failProbe() {
  probeTelegram.mockResolvedValue({ ok: false, status: 500, error: "Bad Gateway", elapsedMs: 12 });
  monitorTelegramProvider.mockResolvedValue(undefined);
}
const multiAgentConfig: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {}, ops: {}, research: {} } },
  ...createTelegramConfig(),
};

function latestMonitorOptions(): {
  token?: string;
  accountId?: string;
  ownerAgentId?: string;
  useWebhook?: boolean;
  botInfo?: unknown;
} {
  const calls = monitorTelegramProvider.mock.calls;
  const options = calls[calls.length - 1]?.[0];
  if (!options || typeof options !== "object") {
    throw new Error("expected monitor Telegram options");
  }
  return options;
}

async function waitForMicrotaskCondition(check: () => boolean, message: string, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

async function releaseStartupProbeControls(releaseProbe: Array<() => void>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const releases = releaseProbe.splice(0);
    for (const release of releases) {
      release();
    }
    await Promise.resolve();
    if (releaseProbe.length === 0) {
      return;
    }
  }
  for (const release of releaseProbe.splice(0)) {
    release();
  }
}

function controlledProbes(blockCount = Infinity) {
  const releases: Array<() => void> = [];
  const counts = { started: 0, active: 0, max: 0 };
  const run = (signal?: AbortSignal) =>
    withTelegramStartupProbeSlot(signal, async () => {
      counts.started++;
      counts.active++;
      counts.max = Math.max(counts.max, counts.active);
      if (counts.started <= blockCount) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      }
      counts.active--;
    });
  return { run, releases, counts };
}

beforeEach(async () => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
  testState = await createOpenClawTestState({ label: "telegram-channel" });
});

afterEach(async () => {
  vi.useRealTimers();
  clearTelegramRuntime();
  resetTelegramPollingLeasesForTests();
  probeTelegram.mockReset();
  monitorTelegramProvider.mockReset();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  await testState.cleanup();
});

describe("telegramPlugin gateway startup", () => {
  it.each([401, 404] as const)(
    "stops before monitor startup when getMe rejects the token with %s",
    async (status) => {
      installTelegramRuntime();
      probeTelegram.mockResolvedValue({
        ok: false,
        status,
        error: "Unauthorized",
        elapsedMs: 12,
      });

      const { ctx, task } = startTelegramAccount("ops");

      await expect(task).rejects.toThrow(
        `Telegram bot token unauthorized for account "ops" (getMe returned ${status}`,
      );
      await expect(task).rejects.toThrow("channels.telegram.accounts.ops.botToken/tokenFile");
      expect(monitorTelegramProvider).not.toHaveBeenCalled();
      expect(ctx.log?.error).toHaveBeenCalledWith(
        `[ops] Telegram bot token unauthorized for account "ops" (getMe returned ${status} from Telegram; source: config token). Update channels.telegram.accounts.ops.botToken/tokenFile with the current BotFather token.`,
      );
      expect(ctx.getStatus()).toMatchObject({
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: expect.stringContaining(`getMe returned ${status}`),
      });
    },
  );

  it("keeps existing fallback startup for non-auth probe failures", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: false,
      status: 500,
      error: "Bad Gateway",
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount();

    await expect(task).resolves.toBeUndefined();
    const monitorOptions = latestMonitorOptions();
    expect(monitorOptions.token).toBe("123456:bad-token");
    expect(monitorOptions.accountId).toBe("default");
    expect(monitorOptions.useWebhook).toBe(false);
  });

  it.each([
    { owner: "main", accountPattern: "*" },
    { owner: "ops", accountPattern: "default" },
  ])("starts a multi-agent account with routed owner $owner", async ({ owner, accountPattern }) => {
    installTelegramRuntime();
    failProbe();
    const cfg: OpenClawConfig = {
      ...multiAgentConfig,
      bindings: [{ agentId: owner, match: { channel: "telegram", accountId: accountPattern } }],
    };
    await startAccount(accountContext(cfg));

    expect(latestMonitorOptions()).toMatchObject({
      accountId: "default",
      ownerAgentId: owner,
    });
  });

  it("rejects genuinely ambiguous multi-agent account ownership before startup", async () => {
    installTelegramRuntime();
    await expect(startAccount(accountContext(multiAgentConfig))).rejects.toMatchObject({
      name: "AgentSelectionRequiredError",
      code: "AGENT_SELECTION_REQUIRED",
    });
    expect(probeTelegram).not.toHaveBeenCalled();
    expect(monitorTelegramProvider).not.toHaveBeenCalled();
  });

  it("caches successful startup probe botInfo for later restarts", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
      bot: {
        id: startupBotInfo.id,
        username: startupBotInfo.username,
      },
      botInfo: startupBotInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops");

    await expect(task).resolves.toBeUndefined();
    expect(latestMonitorOptions().botInfo).toBe(startupBotInfo);
    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toMatchObject({ botInfo: startupBotInfo });
  });

  it("refreshes cached startup botInfo before monitor startup", async () => {
    installTelegramRuntime();
    const refreshedBotInfo = {
      ...startupBotInfo,
      username: "fresh_openclaw_bot",
      has_topics_enabled: true,
    };
    await cacheBotInfo();
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
      bot: {
        id: refreshedBotInfo.id,
        username: refreshedBotInfo.username,
      },
      botInfo: refreshedBotInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops");

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledOnce();
    expect(latestMonitorOptions().botInfo).toEqual(refreshedBotInfo);
    await expect(readCachedTelegramBotInfo(cachedAccount)).resolves.toMatchObject({
      botInfo: refreshedBotInfo,
    });
  });

  it.each(["fresh", "wrong-token", "expired"] as const)(
    "uses only matching fresh startup botInfo after a non-auth refresh failure ($0)",
    async (cacheState) => {
      const runtime = installTelegramRuntime();
      await cacheBotInfo(
        cacheState === "wrong-token" ? "987654:other-token" : cachedAccount.botToken,
      );
      if (cacheState === "expired") {
        const store = runtime.state.openKeyedStore<{
          tokenFingerprint: string;
          fetchedAt: string;
          botInfo: TelegramBotInfo;
        }>({
          namespace: "telegram.bot-info-cache",
          maxEntries: 128,
          defaultTtlMs: 24 * 60 * 60 * 1000,
        });
        const cached = await store.lookup("ops");
        if (!cached) {
          throw new Error("expected persisted startup botInfo");
        }
        await store.register("ops", {
          ...cached,
          fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        });
      }
      failProbe();

      await startTelegramAccount("ops").task;

      expect(latestMonitorOptions().botInfo).toEqual(
        cacheState === "fresh" ? startupBotInfo : undefined,
      );
    },
  );

  it("invalidates botInfo but retains the previous identity until token-change startup", async () => {
    installTelegramRuntime();
    await cacheBotInfo();
    await writeTelegramUpdateOffset({
      accountId: "ops",
      botToken: "123456:bad-token",
      updateId: 42,
    });

    await telegramPlugin.lifecycle?.onAccountConfigChanged?.({
      accountId: "ops",
      prevCfg: createTelegramConfig("ops"),
      nextCfg: createTelegramConfig("ops", { botToken: "654321:new-token" }),
      runtime: createRuntimeSpies(),
    });

    await expectEmptyBotInfo();
    await expect(
      readTelegramUpdateOffset({ accountId: "ops", botToken: "123456:bad-token" }),
    ).resolves.toBe(42);
  });

  it("keeps cached startup botInfo when unrelated Telegram config changes", async () => {
    installTelegramRuntime();
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });

    await telegramPlugin.lifecycle?.onAccountConfigChanged?.({
      accountId: "ops",
      prevCfg: createTelegramConfig("ops"),
      nextCfg: createTelegramConfig("ops", { timeoutSeconds: 60 }),
      runtime: createRuntimeSpies(),
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toMatchObject({ botInfo: startupBotInfo });
  });

  it("deletes cached startup botInfo when the account is removed", async () => {
    installTelegramRuntime();
    await cacheBotInfo();

    await telegramPlugin.lifecycle?.onAccountRemoved?.({
      accountId: "ops",
      prevCfg: createTelegramConfig("ops"),
      runtime: createRuntimeSpies(),
    });

    await expectEmptyBotInfo();
  });

  it("deletes cached startup botInfo when logout clears the account token", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const runtime = installTelegramRuntime();
    const cfg = createTelegramConfig("ops");
    const original = structuredClone(cfg);
    const account = telegramPlugin.config.resolveAccount(cfg, "ops");
    await cacheBotInfo();

    const result = await telegramPlugin.gateway?.logoutAccount?.({
      accountId: "ops",
      account,
      cfg,
      runtime: createRuntimeSpies(),
    });

    expect(result).toEqual({ cleared: true, envToken: false, loggedOut: true });
    expect(runtime.config.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({
      nextConfig: {},
      afterWrite: { mode: "auto" },
    });
    expect(cfg).toEqual(original);
    await expectEmptyBotInfo();
  });

  it("preserves token files and sibling config when logout clears an inline token", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const stateDir = testState.stateDir;
    const runtime = installTelegramRuntime();
    const remaining = { tokenFile: path.join(stateDir, "missing-token"), name: "Ops" };
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: "root-token",
          accounts: { ops: { ...remaining, botToken: "remove" }, other: { botToken: "keep" } },
        },
        line: { enabled: false },
      },
    };
    const original = structuredClone(cfg);
    const result = await telegramPlugin.gateway?.logoutAccount?.({
      accountId: "ops",
      account: telegramPlugin.config.resolveAccount(cfg, "ops"),
      cfg,
      runtime: createRuntimeSpies(),
    });

    expect(result).toEqual({ cleared: true, envToken: false, loggedOut: false });
    expect(runtime.config.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({
      nextConfig: {
        channels: {
          telegram: {
            botToken: "root-token",
            accounts: { ops: remaining, other: { botToken: "keep" } },
          },
          line: { enabled: false },
        },
      },
      afterWrite: { mode: "auto" },
    });
    expect(cfg).toEqual(original);
  });

  it("limits concurrent startup probes across Telegram accounts", async () => {
    const { run, releases, counts } = controlledProbes();
    const tasks = [run(), run(), run()];
    try {
      await waitForMicrotaskCondition(
        () => releases.length === 2,
        "expected two startup probes to begin",
      );
      expect(counts.max).toBe(2);

      releases.shift()?.();
      await waitForMicrotaskCondition(
        () => releases.length === 2,
        "expected queued startup probe to begin after a slot opens",
      );
      expect(counts.max).toBe(2);
    } finally {
      await releaseStartupProbeControls(releases);
    }
    await Promise.all(tasks);
  });

  it("abandons a queued startup probe when the account aborts", async () => {
    const { run, releases, counts } = controlledProbes(2);
    const first = run();
    const second = run();
    const abortQueued = new AbortController();
    const queued = run(abortQueued.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waitForMicrotaskCondition(
        () => releases.length === 2,
        "expected startup probe slots to fill",
      );
      abortQueued.abort();
    } finally {
      abortQueued.abort();
      await releaseStartupProbeControls(releases);
    }
    await Promise.all([first, second]);
    await expect(queued).resolves.toMatchObject({
      message: "telegram startup check wait aborted",
    });
    expect(counts.started).toBe(2);
  });

  it("releases a stopped stale polling lease for the account token", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const lease = { token: "123456:bad-token", accountId: "default" };
    await acquireTelegramPollingLease({ ...lease, abortSignal: abort.signal });
    abort.abort();
    const stop = telegramPlugin.gateway!.stopAccount!(
      accountContext(createTelegramConfig(), "default", abort.signal),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await stop;
    const next = await acquireTelegramPollingLease(lease);
    next.release();
  });
});
