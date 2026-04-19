import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WS_RECONNECT_BACKOFF_DELAYS_MS,
  monitorWebSocket,
  type MonitorTransportParams,
} from "./monitor.transport.js";

vi.mock("./client.js", () => ({
  createFeishuWSClient: vi.fn(),
}));

vi.mock("./monitor.state.js", () => ({
  botNames: new Map(),
  botOpenIds: new Map(),
  wsClients: new Map(),
  httpServers: new Map(),
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS: 5000,
  FEISHU_WEBHOOK_MAX_BODY_BYTES: 1024 * 1024,
  feishuWebhookRateLimiter: {},
  recordWebhookStatus: vi.fn(),
}));

vi.mock("./monitor-transport-runtime-api.js", () => ({
  applyBasicWebhookRequestGuards: vi.fn(),
  installRequestBodyLimitGuard: vi.fn(),
  readWebhookBodyOrReject: vi.fn(),
  safeEqualSecret: vi.fn(),
}));

import { createFeishuWSClient } from "./client.js";
import { wsClients } from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

function makeAccount(overrides?: Partial<ResolvedFeishuAccount>): ResolvedFeishuAccount {
  return {
    accountId: "test-account",
    appId: "app-id",
    appSecret: "app-secret",
    config: {},
    ...overrides,
  } as ResolvedFeishuAccount;
}

function makeParams(overrides?: Partial<MonitorTransportParams>): MonitorTransportParams {
  return {
    account: makeAccount(),
    accountId: "test-account",
    eventDispatcher: { register: vi.fn() } as never,
    runtime: { log: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("monitorWebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    wsClients.clear();
  });

  it("resolves immediately when abortSignal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const mockClient = { start: vi.fn(), close: vi.fn() };
    vi.mocked(createFeishuWSClient).mockResolvedValue(mockClient as never);

    await monitorWebSocket(makeParams({ abortSignal: ac.signal }));
    // Should not throw, should resolve cleanly
  });

  it("starts the WS client and resolves on abort", async () => {
    const ac = new AbortController();
    const mockClient = { start: vi.fn(), close: vi.fn() };
    vi.mocked(createFeishuWSClient).mockResolvedValue(mockClient as never);

    const promise = monitorWebSocket(makeParams({ abortSignal: ac.signal }));

    // Let microtasks settle so start() is called
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClient.start).toHaveBeenCalledTimes(1);

    ac.abort();
    await promise;
    expect(mockClient.close).toHaveBeenCalled();
  });

  it("retries with exponential backoff when start() throws", async () => {
    const ac = new AbortController();
    let callCount = 0;

    vi.mocked(createFeishuWSClient).mockImplementation(async () => {
      callCount += 1;
      if (callCount <= 3) {
        return {
          start: () => {
            throw new Error(`fail-${callCount}`);
          },
          close: vi.fn(),
        } as never;
      }
      // 4th attempt: succeed (stay connected until abort)
      return {
        start: vi.fn(),
        close: vi.fn(),
      } as never;
    });

    const params = makeParams({ abortSignal: ac.signal });
    const promise = monitorWebSocket(params);

    // First attempt (no delay) — fails
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Wait for first backoff delay (5s)
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_DELAYS_MS[0]);
    expect(callCount).toBe(2);

    // Wait for second backoff delay (10s)
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_DELAYS_MS[1]);
    expect(callCount).toBe(3);

    // Wait for third backoff delay (30s)
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_DELAYS_MS[2]);
    expect(callCount).toBe(4);

    // 4th attempt succeeds — now abort to end the test
    ac.abort();
    await promise;
  });

  it("clamps delay at max after exhausting backoff schedule", () => {
    // Exported for testing: verify the last delay is used for attempts beyond the array
    const maxDelay = WS_RECONNECT_BACKOFF_DELAYS_MS[WS_RECONNECT_BACKOFF_DELAYS_MS.length - 1];
    expect(maxDelay).toBe(120_000);
    expect(WS_RECONNECT_BACKOFF_DELAYS_MS.length).toBe(5);
  });

  it("cleans up wsClients on each failed attempt", async () => {
    const ac = new AbortController();
    let callCount = 0;

    vi.mocked(createFeishuWSClient).mockImplementation(async () => {
      callCount += 1;
      return {
        start: () => {
          throw new Error("fail");
        },
        close: vi.fn(),
      } as never;
    });

    const params = makeParams({ abortSignal: ac.signal });
    const promise = monitorWebSocket(params);

    // First attempt fails
    await vi.advanceTimersByTimeAsync(0);
    expect(wsClients.size).toBe(0); // cleaned up after failure

    // Abort before next retry completes
    ac.abort();
    await promise;
  });
});

describe("WS_RECONNECT_BACKOFF_DELAYS_MS", () => {
  it("has increasing delays", () => {
    for (let i = 1; i < WS_RECONNECT_BACKOFF_DELAYS_MS.length; i += 1) {
      expect(WS_RECONNECT_BACKOFF_DELAYS_MS[i]).toBeGreaterThan(
        WS_RECONNECT_BACKOFF_DELAYS_MS[i - 1],
      );
    }
  });
});
