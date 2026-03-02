import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("@larksuiteoapi/node-sdk", () => ({
  adaptDefault: vi.fn(
    () => (_req: unknown, res: { statusCode?: number; end: (s: string) => void }) => {
      res.statusCode = 200;
      res.end("ok");
    },
  ),
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
}));

import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  monitorFeishuProvider,
  stopFeishuMonitor,
} from "./monitor.js";

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntilServerReady(url: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`server did not start: ${url}`);
}

function buildConfig(params: {
  accountId: string;
  path: string;
  port: number;
  verificationToken?: string;
}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          [params.accountId]: {
            enabled: true,
            appId: "cli_test",
            appSecret: "secret_test",
            connectionMode: "webhook",
            webhookHost: "127.0.0.1",
            webhookPort: params.port,
            webhookPath: params.path,
            verificationToken: params.verificationToken,
          },
        },
      },
    },
  } as ClawdbotConfig;
}

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

async function withRunningWebhookMonitor(
  params: {
    accountId: string;
    path: string;
    verificationToken: string;
  },
  run: (url: string) => Promise<void>,
) {
  const port = await getFreePort();
  const cfg = buildConfig({
    accountId: params.accountId,
    path: params.path,
    port,
    verificationToken: params.verificationToken,
  });

  const abortController = new AbortController();
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const monitorPromise = monitorFeishuProvider({
    config: cfg,
    runtime,
    abortSignal: abortController.signal,
  });

  const url = `http://127.0.0.1:${port}${params.path}`;
  await waitUntilServerReady(url);

  try {
    await run(url);
  } finally {
    abortController.abort();
    await monitorPromise;
  }
}

afterEach(() => {
  clearFeishuWebhookRateLimitStateForTest();
  stopFeishuMonitor();
});

describe("Feishu webhook security hardening", () => {
  it("rejects webhook mode without verificationToken", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildConfig({
      accountId: "missing-token",
      path: "/hook-missing-token",
      port: await getFreePort(),
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(
      /requires verificationToken/i,
    );
  });

  it("returns 415 for POST requests without json content type", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "content-type",
        path: "/hook-content-type",
        verificationToken: "verify_token",
      },
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });

        expect(response.status).toBe(415);
        expect(await response.text()).toBe("Unsupported Media Type");
      },
    );
  });

  it("rate limits webhook burst traffic with 429", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "rate-limit",
        path: "/hook-rate-limit",
        verificationToken: "verify_token",
      },
      async (url) => {
        let saw429 = false;
        for (let i = 0; i < 130; i += 1) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          });
          if (response.status === 429) {
            saw429 = true;
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }
        }

        expect(saw429).toBe(true);
      },
    );
  });

  it("caps tracked webhook rate-limit keys to prevent unbounded growth", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4_500; i += 1) {
      isWebhookRateLimitedForTest(`/feishu-rate-limit:key-${i}`, now);
    }
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBeLessThanOrEqual(4_096);
  });

  it("prunes stale webhook rate-limit state after window elapses", () => {
    const now = 2_000_000;
    for (let i = 0; i < 100; i += 1) {
      isWebhookRateLimitedForTest(`/feishu-rate-limit-stale:key-${i}`, now);
    }
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBe(100);

    isWebhookRateLimitedForTest("/feishu-rate-limit-stale:fresh", now + 60_001);
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBe(1);
  });

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

  it("continues startup when a sequential preflight probe times out", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    let releaseBetaProbe!: () => void;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });

    probeFeishuMock.mockImplementation((account: { accountId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return new Promise<never>(() => {});
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
      await Promise.resolve();
      expect(started).toEqual(["alpha"]);

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();

      expect(started).toEqual(["alpha", "beta"]);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("bot info probe timed out"),
      );
    } finally {
      releaseBetaProbe();
      abortController.abort();
      await monitorPromise;
      vi.useRealTimers();
    }
  });

  it("stops sequential preflight when aborted during a stuck probe", async () => {
    const started: string[] = [];
    probeFeishuMock.mockImplementation((account: { accountId: string }) => {
      started.push(account.accountId);
      return new Promise<never>(() => {});
    });

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
