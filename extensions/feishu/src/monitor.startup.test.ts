import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";
import { probeFeishuMock } from "./monitor.test-mocks.js";

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
              appSecret: `secret_${accountId}`,
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
