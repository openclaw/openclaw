import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botNames, botOpenIds, stopFeishuMonitorState, wsClients } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuWSClient: createFeishuWSClientMock,
}));

import { monitorWebSocket } from "./monitor.transport.js";

type MockWsClient = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getReconnectInfo: ReturnType<typeof vi.fn>;
  isConnecting?: boolean;
  wsConfig?: { getWSInstance: ReturnType<typeof vi.fn> };
};

function createAccount(accountId: string): ResolvedFeishuAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    appId: `cli_${accountId}`,
    appSecret: `secret_${accountId}`, // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createWsClient(): MockWsClient {
  const reconnectInfo = { lastConnectTime: 0, nextConnectTime: 0 };
  return {
    start: vi.fn(),
    close: vi.fn(),
    getReconnectInfo: vi.fn(() => reconnectInfo),
    isConnecting: false,
    wsConfig: {
      getWSInstance: vi.fn(() => null),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));
});

afterEach(() => {
  stopFeishuMonitorState();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("feishu websocket cleanup", () => {
  it("closes the websocket client when the monitor aborts", async () => {
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const accountId = "alpha";

    botOpenIds.set(accountId, "ou_alpha");
    botNames.set(accountId, "Alpha");

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    expect(wsClient.start).toHaveBeenCalledTimes(1);
    expect(wsClients.get(accountId)).toBe(wsClient);

    abortController.abort();
    await monitorPromise;

    expect(wsClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.has(accountId)).toBe(false);
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
  });


  it("does not restart a healthy socket when nextConnectTime is stale after reconnect", async () => {
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const accountId = "healthy";
    const log = vi.fn();
    const reconnectInfo = { lastConnectTime: Date.now(), nextConnectTime: Date.now() - 60_000 };
    wsClient.getReconnectInfo.mockImplementation(() => reconnectInfo);
    wsClient.isConnecting = false;
    wsClient.wsConfig = {
      getWSInstance: vi.fn(() => ({ readyState: 1 })),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("WebSocket reconnect seems stalled"));

    abortController.abort();
    await monitorPromise;
  });

  it("restarts the supervisor when retry budget is exhausted without a pending reconnect", async () => {
    const wsClient = createWsClient();
    createFeishuWSClientMock.mockReturnValue(wsClient);

    const abortController = new AbortController();
    const accountId = "exhausted";
    const log = vi.fn();
    const reconnectInfo = { lastConnectTime: Date.now(), nextConnectTime: 0 };
    wsClient.getReconnectInfo.mockImplementation(() => reconnectInfo);
    wsClient.isConnecting = false;
    wsClient.wsConfig = {
      getWSInstance: vi.fn(() => null),
    };

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    await vi.advanceTimersByTimeAsync(100_000);
    await monitorPromise;

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("retry budget exhausted"),
    );
    expect(wsClient.close).toHaveBeenCalled();
  });

  it("closes targeted websocket clients during stop cleanup", () => {
    const alphaClient = createWsClient();
    const betaClient = createWsClient();

    wsClients.set("alpha", alphaClient as never);
    wsClients.set("beta", betaClient as never);
    botOpenIds.set("alpha", "ou_alpha");
    botOpenIds.set("beta", "ou_beta");
    botNames.set("alpha", "Alpha");
    botNames.set("beta", "Beta");

    stopFeishuMonitorState("alpha");

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).not.toHaveBeenCalled();
    expect(wsClients.has("alpha")).toBe(false);
    expect(wsClients.has("beta")).toBe(true);
    expect(botOpenIds.has("alpha")).toBe(false);
    expect(botOpenIds.has("beta")).toBe(true);
    expect(botNames.has("alpha")).toBe(false);
    expect(botNames.has("beta")).toBe(true);
  });

  it("closes all websocket clients during global stop cleanup", () => {
    const alphaClient = createWsClient();
    const betaClient = createWsClient();

    wsClients.set("alpha", alphaClient as never);
    wsClients.set("beta", betaClient as never);
    botOpenIds.set("alpha", "ou_alpha");
    botOpenIds.set("beta", "ou_beta");
    botNames.set("alpha", "Alpha");
    botNames.set("beta", "Beta");

    stopFeishuMonitorState();

    expect(alphaClient.close).toHaveBeenCalledTimes(1);
    expect(betaClient.close).toHaveBeenCalledTimes(1);
    expect(wsClients.size).toBe(0);
    expect(botOpenIds.size).toBe(0);
    expect(botNames.size).toBe(0);
  });
});
