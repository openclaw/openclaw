// Feishu tests cover monitor.startup plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveStartupProbeTimeoutMs } from "./monitor-startup-timeout.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { monitorFeishuProvider } from "./monitor.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import type { ResolvedFeishuAccount } from "./types.js";

const providerIdentity = { ok: true, appId: "cli_alpha", botOpenId: "bot_alpha", botName: "Alpha" };

const alphaAccount: ResolvedFeishuAccount = {
  accountId: "alpha",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "cli_alpha",
  appSecret: "secret_alpha", // pragma: allowlist secret
  domain: "feishu",
  config: FeishuConfigSchema.parse({ connectionMode: "websocket" }),
};

const probeFeishuMock = vi.hoisted(() => vi.fn());
const registerFeishuAiAgentMock = vi.hoisted(() => vi.fn());
const readCachedFeishuBotIdentityMock = vi.hoisted(() => vi.fn());
const writeCachedFeishuBotIdentityMock = vi.hoisted(() => vi.fn());
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const createFeishuDurableIngressMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
  registerFeishuAiAgent: registerFeishuAiAgentMock,
}));

vi.mock("./bot-identity-cache.js", () => ({
  readCachedFeishuBotIdentity: readCachedFeishuBotIdentityMock,
  writeCachedFeishuBotIdentity: writeCachedFeishuBotIdentityMock,
}));

vi.mock("./client.js", async () => {
  const { createFeishuClientMockModule } = await import("./monitor.test-mocks.js");
  return {
    ...createFeishuClientMockModule(),
    createEventDispatcher: createEventDispatcherMock,
  };
});
vi.mock("./feishu-ingress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feishu-ingress.js")>();
  return {
    ...actual,
    createFeishuDurableIngress: (...args: Parameters<typeof actual.createFeishuDurableIngress>) =>
      createFeishuDurableIngressMock(...args) ?? actual.createFeishuDurableIngress(...args),
  };
});
vi.mock("./runtime.js", async () => {
  const { createFeishuRuntimeMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuRuntimeMockModule();
});

beforeAll(async () => {
  await import("./monitor.account.js");
});

beforeEach(() => {
  registerFeishuAiAgentMock.mockReset().mockResolvedValue({ ok: true });
  readCachedFeishuBotIdentityMock.mockReset().mockResolvedValue(null);
  writeCachedFeishuBotIdentityMock.mockReset().mockResolvedValue(undefined);
  createEventDispatcherMock.mockReset().mockReturnValue({ register: vi.fn() });
  createFeishuDurableIngressMock.mockReset().mockReturnValue(undefined);
});

function buildMultiAccountWebsocketConfig(accountIds: string[]): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: Object.fromEntries(
          accountIds.map((accountId) => [
            accountId,
            {
              enabled: true,
              appId: `cli_${accountId}`,
              appSecret: `secret_${accountId}`, // pragma: allowlist secret
              connectionMode: "websocket",
            },
          ]),
        ),
      },
    },
  } as ClawdbotConfig;
}

afterEach(async () => {
  await cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./feishu-ingress.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

describe("Feishu monitor startup preflight", () => {
  it("stops durable ingress when ingress start throws", async () => {
    const startError = new Error("durable ingress unavailable");
    const ingressStart = vi.fn(() => {
      throw startError;
    });
    const ingressStop = vi.fn().mockResolvedValue(undefined);
    createEventDispatcherMock.mockReturnValue({ register: vi.fn(), invoke: vi.fn() });
    createFeishuDurableIngressMock.mockReturnValue({
      invoke: vi.fn(),
      resolveLifecycle: vi.fn(),
      setSocketTerminator: vi.fn(),
      start: ingressStart,
      stop: ingressStop,
      waitForIdle: vi.fn(),
    });
    probeFeishuMock.mockResolvedValue(providerIdentity);

    await expect(
      monitorFeishuProvider({ config: buildMultiAccountWebsocketConfig(["alpha"]) }),
    ).rejects.toBe(startError);

    expect(ingressStart).toHaveBeenCalledTimes(1);
    expect(ingressStop).toHaveBeenCalledTimes(1);
  });

  it("parses startup probe timeout env strictly", () => {
    expect(resolveStartupProbeTimeoutMs({})).toBe(30_000);
    expect(
      resolveStartupProbeTimeoutMs({ OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: "90000" }),
    ).toBe(90_000);
    expect(
      resolveStartupProbeTimeoutMs({
        OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);

    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        resolveStartupProbeTimeoutMs({ OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: value }),
      ).toBe(30_000);
    }
  });

  it("probes sequentially, continues after timeout, and stops the remaining accounts on abort", async () => {
    const started: string[] = [];
    const alphaStarted = createDeferred<void>();
    const betaStarted = createDeferred<void>();
    const alphaResult = createDeferred<{ ok: boolean; error: string }>();
    probeFeishuMock.mockImplementation(
      (account: { accountId: string }, options: { abortSignal?: AbortSignal }) => {
        started.push(account.accountId);
        if (account.accountId === "alpha") {
          alphaStarted.resolve();
          return alphaResult.promise;
        }
        betaStarted.resolve();
        return new Promise((resolve) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "probe aborted" }),
            { once: true },
          );
        });
      },
    );
    const abort = new AbortController();
    const runtime = createNonExitingRuntimeEnv();
    const monitor = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta", "gamma"]),
      runtime,
      abortSignal: abort.signal,
    });
    try {
      await alphaStarted.promise;
      expect(started).toEqual(["alpha"]);
      alphaResult.resolve({ ok: false, error: "probe timed out after 10000ms" });
      await betaStarted.promise;
      expect(started).toEqual(["alpha", "beta"]);
      expect(runtime.error).toHaveBeenCalledWith(
        "feishu[alpha]: bot info check timed out after 30000ms; continuing startup",
      );
      abort.abort();
      await monitor;
      expect(started).toEqual(["alpha", "beta"]);
    } finally {
      alphaResult.resolve({ ok: false, error: "probe aborted" });
      abort.abort();
      await monitor;
    }
  });

  it("returns standard bot identity without waiting for AI-agent registration", async () => {
    probeFeishuMock.mockResolvedValue(providerIdentity);
    const registration = createDeferred<{ ok: false; reason: "api-error" }>();
    registerFeishuAiAgentMock.mockReturnValue(registration.promise);
    const runtime = createNonExitingRuntimeEnv();

    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual({
      botOpenId: "bot_alpha",
      botName: "Alpha",
      source: "provider",
    });
    expect(writeCachedFeishuBotIdentityMock).toHaveBeenCalledWith({
      accountId: "alpha",
      appId: "cli_alpha",
      botOpenId: "bot_alpha",
      botName: "Alpha",
    });
    registration.resolve({ ok: false, reason: "api-error" });
    await registration.promise;
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[alpha]: AI-agent registration unavailable (api-error); continuing with standard bot identity",
    );
  });

  it("rejects a provider result from another app before persistence", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      appId: "cli_old",
      botOpenId: "bot_old",
      botName: "Old",
    });
    readCachedFeishuBotIdentityMock.mockResolvedValue(null);
    const runtime = createNonExitingRuntimeEnv();

    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual({});
    expect(writeCachedFeishuBotIdentityMock).not.toHaveBeenCalled();
    expect(registerFeishuAiAgentMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[alpha]: bot info check returned identity for a different app; ignoring stale result",
    );
  });

  it("bypasses cached identity during background provider refresh", async () => {
    probeFeishuMock.mockResolvedValue({ ok: false, error: "rate limited" });

    await expect(
      fetchBotIdentityForMonitor(alphaAccount, { allowCachedFallback: false }),
    ).resolves.toEqual({});
    expect(readCachedFeishuBotIdentityMock).not.toHaveBeenCalled();
  });

  it("keeps cache read and write failures best-effort", async () => {
    const runtime = createNonExitingRuntimeEnv();
    probeFeishuMock.mockResolvedValueOnce(providerIdentity);
    writeCachedFeishuBotIdentityMock.mockRejectedValueOnce(new Error("state unavailable"));

    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual({
      botOpenId: "bot_alpha",
      botName: "Alpha",
      source: "provider",
    });

    probeFeishuMock.mockResolvedValueOnce({ ok: false, error: "rate limited" });
    readCachedFeishuBotIdentityMock.mockRejectedValueOnce(new Error("state unavailable"));
    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual({});
  });

  it("starts a provider refresh while a cached identity keeps ingress available", async () => {
    probeFeishuMock.mockResolvedValue({ ok: false, error: "rate limited" });
    readCachedFeishuBotIdentityMock.mockResolvedValue({
      botOpenId: "bot_alpha",
      botName: "Alpha",
      fetchedAt: "2026-07-22T23:00:00.000Z",
    });
    const abortController = new AbortController();
    const runtime = createNonExitingRuntimeEnv();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha"]),
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      await vi.waitFor(() => {
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining(
            "feishu[alpha]: bot open_id loaded from cache; starting background provider refresh",
          ),
        );
      });
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });
});
