import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";
import { fetchBotIdentityForMonitor, resetStartupProbeQueueForTest } from "./monitor.startup.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", async () => {
  const { createFeishuClientMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuClientMockModule();
});
vi.mock("./runtime.js", async () => {
  const { createFeishuRuntimeMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuRuntimeMockModule();
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

async function waitForStartedAccount(started: string[], accountId: string) {
  await vi.waitFor(
    () => {
      expect(started).toContain(accountId);
    },
    { timeout: 10_000 },
  );
}

afterEach(() => {
  stopFeishuMonitor();
  resetStartupProbeQueueForTest();
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
      await waitForStartedAccount(started, "alpha");
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
      await waitForStartedAccount(started, "beta");
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
    const runtime = createNonExitingRuntimeEnv();
    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      await waitForStartedAccount(started, "beta");
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
      await waitForStartedAccount(started, "alpha");
      expect(started).toEqual(["alpha"]);

      abortController.abort();
      await monitorPromise;

      expect(started).toEqual(["alpha"]);
    } finally {
      abortController.abort();
    }
  });
});

describe("Feishu startup probe queue serialisation (#63475)", () => {
  it("serialises concurrent fetchBotIdentityForMonitor calls from parallel startAccount", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const gates = new Map<string, () => void>();

    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      const id = account.accountId;
      order.push(`enter:${id}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Wait until the test explicitly releases this probe.
      await new Promise<void>((resolve) => {
        gates.set(id, resolve);
      });
      inFlight -= 1;
      order.push(`exit:${id}`);
      return { ok: true, botOpenId: `bot_${id}` };
    });

    const accounts = ["acct1", "acct2", "acct3"].map((id) => ({
      accountId: id,
      appId: `cli_${id}`,
      appSecret: `secret_${id}`,
    }));

    // Simulate the gateway calling fetchBotIdentityForMonitor concurrently
    // for each account (same pattern as Promise.all in server-channels.ts).
    const promises = accounts.map((acct) => fetchBotIdentityForMonitor(acct as never));

    // Allow microtasks to settle — only the first probe should be in-flight.
    await vi.waitFor(() => expect(gates.size).toBe(1));
    expect(inFlight).toBe(1);
    expect(order).toEqual(["enter:acct1"]);

    // Release first probe.
    gates.get("acct1")!();
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(order).toEqual(["enter:acct1", "exit:acct1", "enter:acct2"]);
    expect(inFlight).toBe(1);

    // Release second probe.
    gates.get("acct2")!();
    await vi.waitFor(() => expect(gates.size).toBe(3));
    expect(order).toEqual([
      "enter:acct1",
      "exit:acct1",
      "enter:acct2",
      "exit:acct2",
      "enter:acct3",
    ]);
    expect(inFlight).toBe(1);

    // Release third probe.
    gates.get("acct3")!();
    const results = await Promise.all(promises);

    expect(maxInFlight).toBe(1);
    expect(results).toEqual([
      { botOpenId: "bot_acct1" },
      { botOpenId: "bot_acct2" },
      { botOpenId: "bot_acct3" },
    ]);
  });

  it("does not block subsequent accounts when one probe fails", async () => {
    const order: string[] = [];
    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      order.push(account.accountId);
      if (account.accountId === "fail") {
        throw new Error("network error");
      }
      return { ok: true, botOpenId: `bot_${account.accountId}` };
    });

    const accounts = ["fail", "ok1", "ok2"].map((id) => ({
      accountId: id,
      appId: `cli_${id}`,
      appSecret: `secret_${id}`,
    }));

    const [r1, r2, r3] = await Promise.all(
      accounts.map((acct) => fetchBotIdentityForMonitor(acct as never)),
    );

    expect(order).toEqual(["fail", "ok1", "ok2"]);
    // The failing probe should still return (error is caught internally).
    expect(r1).toEqual({});
    expect(r2).toEqual({ botOpenId: "bot_ok1" });
    expect(r3).toEqual({ botOpenId: "bot_ok2" });
  });

  it("respects abort signal inside the serialised queue", async () => {
    const order: string[] = [];
    const abortController = new AbortController();

    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      order.push(account.accountId);
      return { ok: true, botOpenId: `bot_${account.accountId}` };
    });

    const accounts = ["a", "b"].map((id) => ({
      accountId: id,
      appId: `cli_${id}`,
      appSecret: `secret_${id}`,
    }));

    // Abort before any probes run.
    abortController.abort();

    const results = await Promise.all(
      accounts.map((acct) =>
        fetchBotIdentityForMonitor(acct as never, { abortSignal: abortController.signal }),
      ),
    );

    // Both should return empty since the signal was already aborted.
    expect(results).toEqual([{}, {}]);
    expect(order).toEqual([]);
  });

  it("aborted account escapes the queue without waiting for the in-flight probe", async () => {
    let releaseAlpha!: () => void;
    const alphaGate = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const order: string[] = [];

    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      order.push(account.accountId);
      if (account.accountId === "alpha") {
        await alphaGate;
      }
      return { ok: true, botOpenId: `bot_${account.accountId}` };
    });

    const accounts = ["alpha", "beta"].map((id) => ({
      accountId: id,
      appId: `cli_${id}`,
      appSecret: `secret_${id}`,
    }));

    const betaAbort = new AbortController();

    // Start both concurrently — alpha enters the probe, beta queues behind it.
    const alphaPromise = fetchBotIdentityForMonitor(accounts[0] as never);
    const betaPromise = fetchBotIdentityForMonitor(accounts[1] as never, {
      abortSignal: betaAbort.signal,
    });

    // Wait for alpha to be in-flight.
    await vi.waitFor(() => expect(order).toEqual(["alpha"]));

    // Abort beta while it is still queued behind alpha's long probe.
    betaAbort.abort();
    const betaResult = await betaPromise;

    // Beta must return immediately with an empty identity — NOT wait for alpha.
    expect(betaResult).toEqual({});
    // Alpha is still running (not released yet).
    expect(order).toEqual(["alpha"]);

    // Release alpha and let the queue drain cleanly.
    releaseAlpha();
    const alphaResult = await alphaPromise;
    expect(alphaResult).toEqual({ botOpenId: "bot_alpha" });
  });
});
