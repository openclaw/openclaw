import { afterEach, describe, expect, it, vi } from "vitest";
import { botNames, botOpenIds, stopFeishuMonitorState, wsClients } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());
const computeBackoffMock = vi.hoisted(() => vi.fn(() => 0));
const sleepWithAbortMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("./client.js", () => ({
  createFeishuWSClient: createFeishuWSClientMock,
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  computeBackoff: computeBackoffMock,
  sleepWithAbort: sleepWithAbortMock,
}));

import { monitorWebSocket } from "./monitor.transport.js";

type MockWsClient = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getReconnectInfo: ReturnType<typeof vi.fn>;
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

function createWsClient(lastConnectTime = 0): MockWsClient {
  return {
    start: vi.fn(),
    close: vi.fn(),
    getReconnectInfo: vi.fn(() => ({ lastConnectTime })),
  };
}

afterEach(() => {
  stopFeishuMonitorState();
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

  it("preserves botOpenIds/botNames across supervisor restart cycles (P1 regression)", async () => {
    // Simulate a stall cycle: first client stalls (getReconnectInfo advances to
    // trigger a reconnect then stops), second client is aborted immediately.
    // Bot identity set during the first cycle must survive into the second cycle.
    vi.useFakeTimers();

    const accountId = "alpha";

    // First wsClient: simulate stall by having lastConnectTime advance once
    // (initial connect) then again (first reconnect), then freeze so the stall
    // clock fires.
    let connectTime = 0;
    const firstClient: MockWsClient = {
      start: vi.fn(),
      close: vi.fn(),
      getReconnectInfo: vi.fn(() => ({ lastConnectTime: connectTime })),
    };

    const abortController = new AbortController();
    const secondClient = createWsClient();
    secondClient.getReconnectInfo.mockReturnValue({ lastConnectTime: 0 });

    createFeishuWSClientMock.mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    // Advance time so the stall poller fires once — lastConnectTime is still 0,
    // so no stall clock starts yet.
    await vi.advanceTimersByTimeAsync(10_000);

    // Simulate the initial connect: lastConnectTime advances.
    connectTime = Date.now();
    await vi.advanceTimersByTimeAsync(10_000);

    // Bot identity is populated (as monitorWebSocket would do via bot-identity).
    botOpenIds.set(accountId, "ou_alpha");
    botNames.set(accountId, "Alpha");

    // Simulate a reconnect attempt — second lastConnectTime change starts the
    // stall clock.
    connectTime = Date.now() + 1;
    await vi.advanceTimersByTimeAsync(10_000);

    // Now freeze — no more lastConnectTime changes. Advance 90 s to trip stall.
    await vi.advanceTimersByTimeAsync(90_000);

    // The first client has stalled. The supervisor should have started the
    // second cycle. At this point botOpenIds/botNames must still be set.
    expect(botOpenIds.has(accountId)).toBe(true);
    expect(botNames.has(accountId)).toBe(true);
    expect(wsClients.get(accountId)).toBe(secondClient);

    // Now abort to let the monitor clean up.
    abortController.abort();
    await vi.runAllTimersAsync();
    await monitorPromise;

    // Shutdown clears everything.
    expect(botOpenIds.has(accountId)).toBe(false);
    expect(botNames.has(accountId)).toBe(false);
    expect(wsClients.has(accountId)).toBe(false);

    vi.useRealTimers();
  });

  it("does not treat a first-attempt-only connect as confirmed (P2 regression — startup outage)", async () => {
    // Simulate a startup-outage: the SDK fires its first connect attempt
    // (lastConnectTime advances once) but the handshake never completes —
    // lastConnectTime then advances again (reconnect) immediately, before
    // stable ticks can accumulate. `hadSuccessfulConnect` must remain false
    // so supervisorAttempt accumulates and exponential backoff is applied.
    vi.useFakeTimers();

    const accountId = "alpha";

    let connectTime = 0;
    const firstClient: MockWsClient = {
      start: vi.fn(),
      close: vi.fn(),
      getReconnectInfo: vi.fn(() => ({ lastConnectTime: connectTime })),
    };

    const abortController = new AbortController();
    const secondClient = createWsClient();
    secondClient.getReconnectInfo.mockReturnValue({ lastConnectTime: 0 });

    createFeishuWSClientMock.mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    // Initial poll tick — lastConnectTime still 0.
    await vi.advanceTimersByTimeAsync(10_000);

    // SDK fires first connect attempt (initial connect).
    connectTime = Date.now();
    await vi.advanceTimersByTimeAsync(10_000);

    // SDK fires reconnect attempt immediately (handshake never confirmed):
    // stable-tick counter resets to 0, so FEISHU_WS_STABLE_TICKS_REQUIRED
    // is never reached and onConfirmedConnect never fires.
    connectTime = Date.now() + 1;
    await vi.advanceTimersByTimeAsync(10_000);

    // Freeze — stall clock starts. Advance 90 s to trip stall.
    await vi.advanceTimersByTimeAsync(90_000);

    // Supervisor enters second cycle. computeBackoff must have been called with
    // attempt >= 1 (not 0) because confirmed connect never fired.
    expect(computeBackoffMock).toHaveBeenCalled();
    const firstCall = computeBackoffMock.mock.calls[0] as unknown as [unknown, number] | undefined;
    const attempt = firstCall?.[1] ?? 0;
    expect(attempt).toBeGreaterThanOrEqual(1);

    abortController.abort();
    await vi.runAllTimersAsync();
    await monitorPromise;

    vi.useRealTimers();
  });

  it("confirms connection and resets supervisorAttempt after stable poll ticks (P2 regression — normal recovery)", async () => {
    // Simulate a healthy connection: lastConnectTime advances once (initial
    // connect) and then remains stable for FEISHU_WS_STABLE_TICKS_REQUIRED
    // consecutive poll ticks without any reconnect attempt. After that, a
    // reconnect followed by a stall should reset supervisorAttempt to 0
    // (fast recovery backoff).
    vi.useFakeTimers();

    const accountId = "alpha";

    let connectTime = 0;
    const firstClient: MockWsClient = {
      start: vi.fn(),
      close: vi.fn(),
      getReconnectInfo: vi.fn(() => ({ lastConnectTime: connectTime })),
    };

    const abortController = new AbortController();
    const secondClient = createWsClient();
    secondClient.getReconnectInfo.mockReturnValue({ lastConnectTime: 0 });

    createFeishuWSClientMock.mockReturnValueOnce(firstClient).mockReturnValueOnce(secondClient);

    const monitorPromise = monitorWebSocket({
      account: createAccount(accountId),
      accountId,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: abortController.signal,
      eventDispatcher: {} as never,
    });

    // Initial poll tick — lastConnectTime still 0.
    await vi.advanceTimersByTimeAsync(10_000);

    // SDK fires initial connect attempt.
    connectTime = Date.now();
    // This tick observes the change (connectChangeCount = 1); no stable count yet.
    await vi.advanceTimersByTimeAsync(10_000);
    // Tick 1: lastConnectTime stable and non-zero (connectedAndStableCount = 1).
    await vi.advanceTimersByTimeAsync(10_000);
    // Tick 2: still stable (connectedAndStableCount = 2 → confirmed! onConfirmedConnect fires).
    await vi.advanceTimersByTimeAsync(10_000);

    // Now trigger a reconnect followed by a stall.
    connectTime = Date.now() + 1;
    await vi.advanceTimersByTimeAsync(10_000);

    // Freeze and wait 90 s to trip the stall.
    await vi.advanceTimersByTimeAsync(90_000);

    // supervisorAttempt was reset to 0 because onConfirmedConnect fired.
    // computeBackoff should have been called with attempt = 0.
    expect(computeBackoffMock).toHaveBeenCalledWith(expect.anything(), 0);

    abortController.abort();
    await vi.runAllTimersAsync();
    await monitorPromise;

    vi.useRealTimers();
  });
});
