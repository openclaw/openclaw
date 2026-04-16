import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";

const fetchBotIdentityForMonitorMock = vi.hoisted(() => vi.fn());
const monitorSingleAccountMock = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {})));

vi.mock("./monitor.startup.js", () => ({
  fetchBotIdentityForMonitor: fetchBotIdentityForMonitorMock,
}));

vi.mock("./monitor.account.js", () => ({
  monitorSingleAccount: monitorSingleAccountMock,
  resolveReactionSyntheticEvent: vi.fn(),
}));

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
  vi.clearAllMocks();
});

describe("Feishu monitor startup preflight", () => {
  it("probes multiple accounts concurrently instead of serially", async () => {
    const started: string[] = [];
    let releaseProbes!: () => void;
    const probesReleased = new Promise<void>((resolve) => {
      releaseProbes = resolve;
    });

    fetchBotIdentityForMonitorMock.mockImplementation(async (account: { accountId: string }) => {
      started.push(account.accountId);
      await probesReleased;
      return { botOpenId: `bot_${account.accountId}` };
    });

    const monitorPromise = monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha", "beta", "gamma"]),
    });

    await Promise.resolve();
    expect(started.sort()).toEqual(["alpha", "beta", "gamma"]);

    releaseProbes();
    await monitorPromise;
  });

  it("forces startup probe timeoutMs to 3000ms", async () => {
    fetchBotIdentityForMonitorMock.mockResolvedValue({ botOpenId: "bot_alpha" });

    await monitorFeishuProvider({
      config: buildMultiAccountWebsocketConfig(["alpha"]),
    });

    expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "alpha" }),
      expect.objectContaining({ timeoutMs: 3000 }),
    );
  });

  it("starts runtime monitors in background and returns after probes complete", async () => {
    fetchBotIdentityForMonitorMock.mockResolvedValue({ botOpenId: "bot_alpha" });

    await expect(
      monitorFeishuProvider({
        config: buildMultiAccountWebsocketConfig(["alpha"]),
      }),
    ).resolves.toBeUndefined();

    expect(monitorSingleAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        botOpenIdSource: expect.objectContaining({
          kind: "prefetched",
          botOpenId: "bot_alpha",
        }),
      }),
    );
  });

  it("degrades failed probes instead of blocking startup", async () => {
    fetchBotIdentityForMonitorMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ botOpenId: "bot_beta" });

    await expect(
      monitorFeishuProvider({
        config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      }),
    ).resolves.toBeUndefined();

    expect(monitorSingleAccountMock).toHaveBeenCalledTimes(1);
    expect(monitorSingleAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ accountId: "beta" }),
      }),
    );
  });
});
