// Feishu tests cover monitor.startup plugin behavior.
import { EventDispatcher } from "@larksuiteoapi/node-sdk";
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
import { getFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const providerIdentity = { ok: true, appId: "cli_alpha", botOpenId: "bot_alpha", botName: "Alpha" };
const resolvedIdentity = { botOpenId: "bot_alpha", source: "provider" };

const alphaAccount: ResolvedFeishuAccount = {
  accountId: "alpha",
  enabled: true,
  configured: true,
  appId: "cli_alpha",
  appSecret: "secret_alpha", // pragma: allowlist secret
  domain: "feishu",
  config: FeishuConfigSchema.parse({ connectionMode: "websocket" }),
};

const probeFeishuMock = vi.hoisted(() => vi.fn());
const registerFeishuAiAgentMock = vi.hoisted(() => vi.fn());
const identityStore = vi.hoisted(() => ({ lookup: vi.fn(), register: vi.fn(), open: vi.fn() }));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const createFeishuDurableIngressMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
  registerFeishuAiAgent: registerFeishuAiAgentMock,
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
  createEventDispatcher: createEventDispatcherMock,
}));
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
  identityStore.lookup.mockReset().mockResolvedValue(undefined);
  identityStore.register.mockReset().mockResolvedValue(undefined);
  identityStore.open.mockReset().mockReturnValue(identityStore);
  getFeishuRuntime().state.openKeyedStore = identityStore.open;
  createEventDispatcherMock.mockReset().mockImplementation(() => new EventDispatcher({}));
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

    expect(ingressStop).toHaveBeenCalledTimes(1);
  });

  it("parses startup probe timeout env strictly", () => {
    expect(resolveStartupProbeTimeoutMs({})).toBe(30_000);
    for (const [value, expected] of [
      ["90000", 90_000],
      [String(Number.MAX_SAFE_INTEGER), MAX_TIMER_TIMEOUT_MS],
      ...["0x10", "1e3", "10.5"].map((invalid) => [invalid, 30_000] as const),
    ] as const) {
      expect(
        resolveStartupProbeTimeoutMs({ OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: value }),
      ).toBe(expected);
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

    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual(
      resolvedIdentity,
    );
    expect(identityStore.register).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ appId: "cli_alpha", botOpenId: "bot_alpha" }),
    );
    registration.resolve({ ok: false, reason: "api-error" });
    await registration.promise;
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[alpha]: AI-agent registration unavailable (api-error); continuing with standard bot identity",
    );
  });

  it("rejects a provider result from another app before persistence", async () => {
    probeFeishuMock.mockResolvedValue({ ...providerIdentity, appId: "cli_old" });
    const runtime = createNonExitingRuntimeEnv();

    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual({});
    expect(identityStore.register).not.toHaveBeenCalled();
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
    expect(identityStore.lookup).not.toHaveBeenCalled();
  });

  it("keeps cache read and write failures best-effort", async () => {
    const runtime = createNonExitingRuntimeEnv();
    probeFeishuMock.mockResolvedValueOnce(providerIdentity);
    identityStore.register.mockRejectedValueOnce(new Error("state unavailable"));

    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual(
      resolvedIdentity,
    );

    probeFeishuMock.mockResolvedValueOnce({ ok: false, error: "rate limited" });
    identityStore.lookup.mockRejectedValueOnce(new Error("state unavailable"));
    await expect(fetchBotIdentityForMonitor(alphaAccount, { runtime })).resolves.toEqual({});
  });

  it("starts a provider refresh while a cached identity keeps ingress available", async () => {
    probeFeishuMock.mockResolvedValue({ ok: false, error: "rate limited" });
    identityStore.lookup.mockResolvedValue({
      appId: "cli_alpha",
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

describe("Feishu bot identity cache", () => {
  const account = { ...alphaAccount, accountId: "person-2", appId: "cli_person_2" };
  const entries = new Map<string, unknown>();
  beforeEach(() => {
    entries.clear();
    probeFeishuMock.mockReset().mockResolvedValue({ ok: false, error: "provider unavailable" });
    identityStore.lookup.mockImplementation(async (key: string) => entries.get(key));
    identityStore.register.mockImplementation(async (key: string, value: unknown) => {
      entries.set(key, value);
    });
  });
  afterEach(() => vi.useRealTimers());

  it("persists provider-verified identity in a bounded plugin-state namespace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T23:00:00.000Z"));

    probeFeishuMock.mockResolvedValue({
      ok: true,
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
      botName: "OpenClaw QA",
    });
    await fetchBotIdentityForMonitor(account);
    probeFeishuMock.mockResolvedValue({ ok: false, error: "provider unavailable" });

    expect(entries.get("person-2")).toEqual({
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
      botName: "OpenClaw QA",
      fetchedAt: "2026-07-22T23:00:00.000Z",
    });
    await expect(fetchBotIdentityForMonitor(account)).resolves.toEqual({
      botOpenId: "ou_bot_person_2",
      source: "cache",
    });
    expect(identityStore.open).toHaveBeenCalledWith({
      namespace: "feishu.bot-identity-cache",
      maxEntries: 128,
    });
  });

  it("keeps identity across secret rotation but rejects a different app id", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
    });
    await fetchBotIdentityForMonitor(account);
    probeFeishuMock.mockResolvedValue({ ok: false, error: "provider unavailable" });

    await expect(
      fetchBotIdentityForMonitor({ ...account, appSecret: "rotated" }),
    ).resolves.toMatchObject({ botOpenId: "ou_bot_person_2" });
    await expect(
      fetchBotIdentityForMonitor({ ...account, appId: "cli_replacement" }),
    ).resolves.toEqual({});
  });

  it("rejects malformed or incomplete persisted values", async () => {
    entries.set("person-2", {
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
      fetchedAt: "not-a-date",
    });

    await expect(fetchBotIdentityForMonitor(account)).resolves.toEqual({});
  });

  it("does not persist an identity without both app and bot ids", async () => {
    for (const identity of [
      { appId: undefined, botOpenId: "ou_bot_person_2" },
      { appId: "cli_person_2", botOpenId: undefined },
    ]) {
      probeFeishuMock.mockResolvedValue({ ok: true, ...identity });
      await fetchBotIdentityForMonitor({ ...account, appId: identity.appId });
    }
    expect(entries.size).toBe(0);
  });
});
