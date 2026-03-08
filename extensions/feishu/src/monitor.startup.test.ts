import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";
import { botOpenIds } from "./monitor.state.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const feishuClientMockModule = vi.hoisted(() => ({
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
}));
const feishuRuntimeMockModule = vi.hoisted(() => ({
  getFeishuRuntime: () => ({
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
        }),
      },
      text: {
        hasControlCommand: () => false,
      },
    },
  }),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => feishuClientMockModule);
vi.mock("./runtime.js", () => feishuRuntimeMockModule);

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

afterEach(() => {
  stopFeishuMonitor();
});

describe("Feishu monitor startup preflight", () => {
  it("starts account probes sequentially to avoid startup bursts", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    let releaseProbes!: () => void;
    const probesReleased = new Promise<void>((resolve) => {
      releaseProbes = () => resolve();
    });
    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      started.push(account.accountId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await probesReleased;
      inFlight -= 1;
      return { ok: true, botOpenId: `bot_${account.accountId}` };
    });

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta", "gamma"]),
      abortSignal: abortController.signal,
    });

    try {
      await Promise.resolve();
      await Promise.resolve();

      expect(started).toEqual(["alpha"]);
      expect(maxInFlight).toBe(1);
    } finally {
      releaseProbes();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("does not refetch bot info after a failed sequential preflight", async () => {
    const started: string[] = [];
    let releaseBetaProbe!: () => void;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });

    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return { ok: false };
      }
      await betaProbeReleased;
      return { ok: true, botOpenId: `bot_${account.accountId}` };
    });

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      abortSignal: abortController.signal,
    });

    try {
      for (let i = 0; i < 10 && !started.includes("beta"); i += 1) {
        await Promise.resolve();
      }

      expect(started).toEqual(["alpha", "beta"]);
      expect(started.filter((accountId) => accountId === "alpha")).toHaveLength(1);
    } finally {
      releaseBetaProbe();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("continues startup when probe layer reports timeout", async () => {
    const started: string[] = [];
    let releaseBetaProbe!: () => void;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });

    probeFeishuMock.mockImplementation((account: { accountId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return Promise.resolve({ ok: false, error: "probe timed out after 10000ms" });
      }
      return betaProbeReleased.then(() => ({ ok: true, botOpenId: `bot_${account.accountId}` }));
    });

    const abortController = new AbortController();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      for (let i = 0; i < 10 && !started.includes("beta"); i += 1) {
        await Promise.resolve();
      }

      expect(started).toEqual(["alpha", "beta"]);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("bot info probe timed out"),
      );
    } finally {
      releaseBetaProbe();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("single-account startup prefetches bot open_id without duplicate fetch", async () => {
    probeFeishuMock.mockReset();
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_solo" });

    const abortController = new AbortController();
    const cfg = buildMultiAccountWebsocketConfig(["solo"]);
    const monitorPromise = monitorFeishuProvider({
      config: cfg,
      accountId: "solo",
      abortSignal: abortController.signal,
    });

    try {
      // Let the prefetch and monitorSingleAccount resolve.
      for (let i = 0; i < 10 && !botOpenIds.has("solo"); i += 1) {
        await Promise.resolve();
      }

      // probeFeishu should be called exactly once (prefetch in monitorFeishuProvider),
      // not twice (prefetch + monitorSingleAccount fallback fetch).
      expect(probeFeishuMock).toHaveBeenCalledTimes(1);
      // Verify the prefetched value was stored correctly.
      expect(botOpenIds.get("solo")).toBe("bot_solo");
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("single-account startup does not re-fetch when probe returns undefined", async () => {
    probeFeishuMock.mockReset();
    probeFeishuMock.mockResolvedValue({ ok: false, error: "probe timed out after 10000ms" });

    const abortController = new AbortController();
    const cfg = buildMultiAccountWebsocketConfig(["solo"]);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const monitorPromise = monitorFeishuProvider({
      config: cfg,
      accountId: "solo",
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      for (let i = 0; i < 10 && !botOpenIds.has("solo"); i += 1) {
        await Promise.resolve();
      }

      // Probe failed but should still only be called once, not retried by monitorSingleAccount.
      expect(probeFeishuMock).toHaveBeenCalledTimes(1);
      // botOpenId stored as empty string when probe fails.
      expect(botOpenIds.get("solo")).toBe("");
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("single-account startup skips monitor when aborted during prefetch", async () => {
    probeFeishuMock.mockReset();
    const abortController = new AbortController();
    probeFeishuMock.mockImplementation(async () => {
      abortController.abort();
      return { ok: false, error: "aborted" };
    });

    const cfg = buildMultiAccountWebsocketConfig(["solo"]);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await monitorFeishuProvider({
      config: cfg,
      accountId: "solo",
      runtime,
      abortSignal: abortController.signal,
    });

    // Probe was called once (the prefetch), but monitorSingleAccount should
    // not have run because the abort was detected after prefetch.
    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(botOpenIds.has("solo")).toBe(false);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("abort signal received during startup prefetch"),
    );
  });

  it("stops sequential preflight when aborted during probe", async () => {
    const started: string[] = [];
    probeFeishuMock.mockImplementation(
      (account: { accountId: string }, options: { abortSignal?: AbortSignal }) => {
        started.push(account.accountId);
        return new Promise((resolve) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "probe aborted" }),
            { once: true },
          );
        });
      },
    );

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      abortSignal: abortController.signal,
    });

    try {
      await Promise.resolve();
      expect(started).toEqual(["alpha"]);

      abortController.abort();
      await monitorPromise;

      expect(started).toEqual(["alpha"]);
    } finally {
      abortController.abort();
    }
  });
});
