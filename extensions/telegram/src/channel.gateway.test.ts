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
import { getOrCreateAccountThrottler, releaseAccountThrottler } from "./account-throttler.js";
import { readCachedTelegramBotInfo, writeCachedTelegramBotInfo } from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { telegramPlugin } from "./channel.js";
import { acquireTelegramPollingLease } from "./polling-lease.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramAccountThrottlersForTest,
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

const startupBotInfo: TelegramBotInfo = { ...telegramBotInfoForTest, id: 123456 };

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

  describe("account throttler lifecycle", () => {
    beforeEach(() => {
      resetTelegramAccountThrottlersForTest();
    });
    afterEach(() => {
      resetTelegramAccountThrottlersForTest();
    });

    const token = "123456:bad-token";
    const accounts = (ops: string | undefined, other?: string): OpenClawConfig => ({
      channels: {
        telegram: {
          accounts: {
            ...(ops ? { ops: { botToken: ops } } : {}),
            ...(other ? { other: { botToken: other } } : {}),
          },
        },
      },
    });
    it.each([
      ["rotate", false, false],
      ["rotate", true, true],
      ["remove", false, false],
      ["remove", true, true],
      ["unrelated", false, true],
    ] as const)("%s (shared=%s) retains throttler=%s", async (change, shared, retained) => {
      installTelegramRuntime();
      const prevCfg = accounts(token, shared ? token : undefined);
      const first = getOrCreateAccountThrottler(token);
      const context = { accountId: "ops", prevCfg, runtime: createRuntimeSpies() };
      if (change === "remove") {
        await telegramPlugin.lifecycle?.onAccountRemoved?.(context);
      } else {
        await telegramPlugin.lifecycle?.onAccountConfigChanged?.({
          ...context,
          nextCfg:
            change === "rotate"
              ? accounts("654321:new-token", shared ? token : undefined)
              : createTelegramConfig("ops", { timeoutSeconds: 60 }),
        });
      }
      expect(getOrCreateAccountThrottler(token) === first).toBe(retained);
      await releaseAccountThrottler(token);
    });

    it.each(["rotated", "removed", "configured"] as const)(
      "stops an account whose token is %s",
      async (state) => {
        const runtime = installTelegramRuntime();
        const cfg = createTelegramConfig("ops");
        runtime.config.current = () =>
          state === "configured"
            ? cfg
            : state === "rotated"
              ? accounts("654321:new-token")
              : accounts(undefined, "789:other-token");
        const first = getOrCreateAccountThrottler(token);
        await telegramPlugin.gateway!.stopAccount!(accountContext(cfg, "ops"));
        expect(getOrCreateAccountThrottler(token) === first).toBe(state === "configured");
        await releaseAccountThrottler(token);
      },
    );
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

  it.each([false, true])("settles a queued startup probe (aborted: %s)", async (aborted) => {
    const probes = Array.from({ length: 3 }, () => ({
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    }));
    const abort = new AbortController();
    let active = 0,
      started = 0,
      max = 0;
    const tasks = probes.map((probe, index) => {
      const task = withTelegramStartupProbeSlot(
        index === 2 ? abort.signal : undefined,
        async () => {
          started++;
          max = Math.max(max, ++active);
          probe.entered.resolve();
          await probe.release.promise;
          active--;
        },
      );
      return index === 2 && aborted ? task.catch((error: unknown) => error) : task;
    });
    try {
      await Promise.all(probes.slice(0, 2).map((probe) => probe.entered.promise));
      expect(max).toBe(2);
      expect(started).toBe(2);
      if (aborted) {
        abort.abort();
        await expect(tasks[2]).resolves.toMatchObject({
          message: "telegram startup check wait aborted",
        });
        expect(started).toBe(2);
      } else {
        probes[0]!.release.resolve();
        await probes[2]!.entered.promise;
        expect(max).toBe(2);
        expect(started).toBe(3);
      }
    } finally {
      abort.abort();
      for (const probe of probes) {
        probe.release.resolve();
      }
      await Promise.all(tasks);
    }
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
