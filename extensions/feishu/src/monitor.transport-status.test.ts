// Tests for transport activity status publishing in monitorWebSocket and
// monitorWebhook. These tests exercise the status sink wiring that allows the
// gateway channel health monitor to detect a silent feishu channel.
// See PROPOSAL.md for the incident background.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatusPatch = {
  connected?: boolean;
  lastConnectedAt?: number | null;
  lastEventAt?: number | null;
  lastTransportActivityAt?: number | null;
  lastError?: string | null;
};

type StatusSink = (patch: StatusPatch) => void;

function createRecordingSink(): { sink: StatusSink; calls: StatusPatch[] } {
  const calls: StatusPatch[] = [];
  return {
    sink: (patch) => {
      calls.push(patch);
    },
    calls,
  };
}

async function loadTransportModule() {
  return await import("./monitor.transport.js");
}

describe("monitorWebSocket status publishing", () => {
  let originalNow: () => number;
  let nowValue: number;

  beforeEach(() => {
    nowValue = 1_700_000_000_000;
    originalNow = Date.now;
    Date.now = () => nowValue;
  });

  afterEach(() => {
    Date.now = originalNow;
    vi.restoreAllMocks();
  });

  it("publishes connected + lastEventAt on successful WS handshake", async () => {
    const recorder = createRecordingSink();
    const fakeWsClient = {
      start: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const { monitorWebSocket } = await loadTransportModule();

    const account = {
      accountId: "acct-1",
      appId: "app",
      appSecret: "secret",
      domain: "https://open.feishu.cn",
      encryptKey: undefined,
      verificationToken: undefined,
      config: { connectionMode: "websocket" as const },
    } as never;

    const abortController = new AbortController();

    // Start the monitor in background; it will call createFeishuWSClient.
    const wsClientModule = await import("./client.js");
    vi.spyOn(wsClientModule, "createFeishuWSClient").mockResolvedValue(fakeWsClient as never);

    const monitorPromise = monitorWebSocket({
      account,
      accountId: "acct-1",
      abortSignal: abortController.signal,
      eventDispatcher: { register: () => undefined } as never,
      statusSink: recorder.sink,
    });

    // Let the WS handshake complete.
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
    // Status should be published immediately after wsClient.start resolves.
    expect(recorder.calls.length).toBeGreaterThanOrEqual(1);
    const first = recorder.calls[0];
    expect(first?.connected).toBe(true);
    expect(first?.lastConnectedAt).toBe(nowValue);
    expect(first?.lastEventAt).toBe(nowValue);
    expect(first?.lastTransportActivityAt).toBe(nowValue);
    expect(first?.lastError).toBeNull();

    // Trigger abort to terminate the monitor cleanly.
    abortController.abort();
    await monitorPromise;
  });

  it("publishes disconnected when WS handshake throws", async () => {
    const recorder = createRecordingSink();
    const { monitorWebSocket } = await loadTransportModule();

    const account = {
      accountId: "acct-2",
      appId: "app",
      appSecret: "secret",
      domain: "https://open.feishu.cn",
      encryptKey: undefined,
      verificationToken: undefined,
      config: { connectionMode: "websocket" as const },
    } as never;

    const abortController = new AbortController();
    const wsClientModule = await import("./client.js");
    vi.spyOn(wsClientModule, "createFeishuWSClient").mockRejectedValue(new Error("boom"));

    // Pre-abort so the monitor exits after the first failed attempt.
    setImmediate(() => abortController.abort());

    const monitorPromise = monitorWebSocket({
      account,
      accountId: "acct-2",
      abortSignal: abortController.signal,
      eventDispatcher: { register: () => undefined } as never,
      statusSink: recorder.sink,
    });

    await monitorPromise;

    const disconnected = recorder.calls.find((c) => c.connected === false);
    expect(disconnected).toBeDefined();
    expect(disconnected?.lastEventAt).toBe(nowValue);
    expect(disconnected?.lastTransportActivityAt).toBe(nowValue);
  });
});

describe("monitorWebhook status publishing", () => {
  let originalNow: () => number;
  let nowValue: number;

  beforeEach(() => {
    nowValue = 1_700_000_001_000;
    originalNow = Date.now;
    Date.now = () => nowValue;
  });

  afterEach(() => {
    Date.now = originalNow;
    vi.restoreAllMocks();
  });

  it("publishes connected on listen success", async () => {
    const recorder = createRecordingSink();
    const { monitorWebhook } = await loadTransportModule();

    const account = {
      accountId: "webhook-acct",
      appId: "app",
      appSecret: "secret",
      domain: "https://open.feishu.cn",
      encryptKey: "ek",
      verificationToken: "vt",
      config: {
        connectionMode: "webhook" as const,
        webhookPort: 0,
        webhookPath: "/feishu/events",
        webhookHost: "127.0.0.1",
      },
    } as never;

    const abortController = new AbortController();

    const monitorPromise = monitorWebhook({
      account,
      accountId: "webhook-acct",
      abortSignal: abortController.signal,
      eventDispatcher: { register: () => undefined, invoke: vi.fn() } as never,
      statusSink: recorder.sink,
    });

    // Give the server time to listen.
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 50);
    });

    const connected = recorder.calls.find((c) => c.connected === true);
    expect(connected).toBeDefined();
    expect(connected?.lastConnectedAt).toBe(nowValue);
    expect(connected?.lastEventAt).toBe(nowValue);

    abortController.abort();
    await monitorPromise;
  });
});

describe("FeishuStatusSink type contract", () => {
  it("accepts a partial patch with only lastEventAt", async () => {
    // Verifies the type signature allows the patterns we use. A compile-time
    // check via tsserver; the runtime assertion is the call must not throw.
    const recorder = createRecordingSink();
    const sink: StatusSink = recorder.sink;
    sink({ lastEventAt: 12345 });
    expect(recorder.calls).toEqual([{ lastEventAt: 12345 }]);
  });
});
