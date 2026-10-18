import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayClient, GatewayClientRequestTimeoutError } from "./client.js";
import { transportFixture, sendChallenge, sendResponse } from "./client.transport.test-support.js";
import {
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolSocket,
} from "./protocol-client.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "./timeouts.js";
import { rawDataToString } from "./websocket-data.js";
import { WebSocket } from "./websocket.test-support.js";

test("decodes every ws raw-data shape", () => {
  expect(rawDataToString(Buffer.from("buffer"))).toBe("buffer");
  expect(rawDataToString(Uint8Array.from(Buffer.from("array-buffer")).buffer)).toBe("array-buffer");
  expect(rawDataToString([Buffer.from("frag"), Buffer.from("ments")])).toBe("fragments");
  expect(rawDataToString(Buffer.from([0xe9]), "latin1")).toBe("é");
});

type ProtocolHarness = {
  socket: GatewayProtocolSocket | null;
  stopped: boolean;
  generation: number;
  hasPendingRequests: boolean;
  reconnectSupervisor: { reset(initialMs?: number): void };
  handleMessage: (socket: GatewayProtocolSocket, generation: number, raw: string) => void;
};

function protocolHarness(client: GatewayClient): ProtocolHarness {
  return (client as unknown as { protocol: ProtocolHarness }).protocol;
}

function installSyntheticSocket(
  client: GatewayClient,
  send: (data: string) => unknown,
  close: (code?: number, reason?: string) => unknown,
): void {
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    send: (data) => send(data),
    close: (code, reason) => close(code, reason),
  };
  Object.assign(protocolHarness(client), { socket, stopped: false, generation: 1 });
  (client as unknown as { ws: unknown }).ws = {
    readyState: WebSocket.OPEN,
    send,
    close,
    terminate: vi.fn(),
  };
}

function createWatchedGatewayClient(tickIntervalMs = 5) {
  const client = new GatewayClient({
    requestTimeoutMs: 100,
    tickWatchMinIntervalMs: 5,
    tickWatchTimeoutMs: 10,
  });
  const close = vi.fn();
  const send = vi.fn();
  installSyntheticSocket(client, send, close);
  Object.assign(client as unknown as { tickIntervalMs: number; lastTick: number }, {
    tickIntervalMs,
    lastTick: Date.now(),
  });
  (client as unknown as { startTickWatch: () => void }).startTickWatch();
  return { client, close, send };
}

function handleGatewayMessage(client: GatewayClient, payload: Record<string, unknown>): void {
  const protocol = protocolHarness(client);
  if (!protocol.socket) {
    throw new Error("synthetic protocol socket missing");
  }
  protocol.handleMessage(protocol.socket, protocol.generation, JSON.stringify(payload));
}

async function stopSyntheticClient(client: GatewayClient): Promise<void> {
  client.stop();
  await vi.advanceTimersByTimeAsync(250);
}

describe("GatewayClient", () => {
  const { startWebSocketServer: startServer } = transportFixture();

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    // Timer spies must restore their fake functions before the clock uninstalls them.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("sends the configured websocket origin", async () => {
    const { server, url, origin } = await startServer();
    const receivedOrigin = new Promise<string | undefined>((resolve) => {
      server.once("connection", (_socket, request) => resolve(request.headers.origin));
    });
    const client = new GatewayClient({ url, origin, connectChallengeTimeoutMs: 0 });
    client.start();

    await expect(receivedOrigin).resolves.toBe(origin);
    client.stop();
  });

  test("returns non-sensitive connection metadata", () => {
    const client = new GatewayClient({
      clientName: "cli",
      mode: "backend",
      preauthHandshakeTimeoutMs: 30_000,
      deviceIdentity: {
        deviceId: "device-1",
        privateKeyPem: "private-key",
        publicKeyPem: "public-key",
      },
    });

    expect(client.getConnectionMetadata()).toEqual({
      clientName: "cli",
      hasDeviceIdentity: true,
      mode: "backend",
      preauthHandshakeTimeoutMs: 30_000,
    });
  });

  test("reconnects with updated node manifest metadata", () => {
    const client = new GatewayClient({ caps: ["system"], commands: ["system.run"] });
    const close = vi.fn();
    installSyntheticSocket(client, vi.fn(), close);

    const manifest = {
      caps: ["canvas", "system"],
      commands: ["canvas.present", "system.run"],
      workerRuns: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.12",
        protocolFeatures: ["worker-heartbeat-v1"],
      },
    };
    client.updateNodeManifest(structuredClone(manifest));

    expect(close).toHaveBeenCalledWith(1012, "node manifest changed");
    expect((client as unknown as { opts: Record<string, unknown> }).opts).toMatchObject(manifest);
  });

  test("rejects an unbounded request, reconnects, and does not replay it", async () => {
    const { server, url } = await startServer();

    const methodsByConnection: string[][] = [];
    server.on("connection", (socket) => {
      const methods: string[] = [];
      methodsByConnection.push(methods);
      sendChallenge(socket, {
        nonce: `nonce-${methodsByConnection.length}`,
        ts: 1_777_777_777_000,
      });
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
        methods.push(frame.method);
        if (frame.method === "connect") {
          sendResponse(socket, frame.id, {
            type: "hello-ok",
            protocol: 4,
            policy: { tickIntervalMs: 20 },
          });
          return;
        }
        if (frame.method === "status") {
          sendResponse(socket, frame.id, { status: "ok" });
        }
      });
    });

    const firstHello = createDeferred();
    const secondHello = createDeferred();
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let helloCount = 0;
    const client = new GatewayClient({
      url,
      tickWatchMinIntervalMs: 5,
      onHelloOk: () => {
        helloCount += 1;
        if (helloCount === 1) {
          // Keep the real reconnect lifecycle fast without changing production defaults.
          protocolHarness(client).reconnectSupervisor.reset(10);
          firstHello.resolve();
          return;
        }
        secondHello.resolve();
      },
      onClose: (code, reason) => closeEvents.push({ code, reason }),
    });

    try {
      client.start();
      await firstHello.promise;

      const stalledRequest = client.request("chat.send", undefined, { expectFinal: true });
      void stalledRequest.catch(() => {});

      await expect(stalledRequest).rejects.toThrow("gateway closed (4000): tick timeout");
      await secondHello.promise;
      await expect(client.request("status")).resolves.toEqual({ status: "ok" });

      expect(closeEvents[0]).toEqual({ code: 4000, reason: "tick timeout" });
      expect(methodsByConnection[0]).toEqual(["connect", "chat.send"]);
      expect(methodsByConnection[1]).toEqual(["connect", "status"]);
      expect(methodsByConnection.flat().filter((method) => method === "chat.send")).toHaveLength(1);
    } finally {
      await client.stopAndWait();
    }
  }, 5000);

  test("lets finite pending requests own their timeout when ticks are missing", async () => {
    vi.useFakeTimers();
    const { client, close } = createWatchedGatewayClient();
    const request = client.request("status", undefined, { timeoutMs: 100 });
    const outcome = request.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);

    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(80);
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayClientRequestTimeoutError);
    expect(error).toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(error).toMatchObject({
      message: "gateway request timeout for status",
      code: "CLIENT_TIMEOUT",
      method: "status",
      timeoutMs: 100,
      requestSent: true,
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    await stopSyntheticClient(client);
  });

  test("keeps the watchdog active for mixed finite and unbounded requests", async () => {
    vi.useFakeTimers();
    const { client, close } = createWatchedGatewayClient();
    const requests = [
      client.request("status", undefined, { timeoutMs: 100 }),
      client.request("chat.send", undefined, { expectFinal: true }),
    ];
    const settlements = Promise.allSettled(requests);

    await vi.advanceTimersByTimeAsync(20);

    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    await stopSyntheticClient(client);
    await expect(settlements).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  test("keeps an unbounded request alive while inbound ticks continue", async () => {
    vi.useFakeTimers();
    const { client, close, send } = createWatchedGatewayClient();
    const request = client.request<{ status: string }>("chat.send", undefined, {
      expectFinal: true,
    });
    const requestFrame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };

    for (let seq = 1; seq <= 4; seq += 1) {
      await vi.advanceTimersByTimeAsync(5);
      handleGatewayMessage(client, { type: "event", event: "tick", seq, payload: {} });
    }

    expect(close).not.toHaveBeenCalled();
    handleGatewayMessage(client, {
      type: "res",
      id: requestFrame.id,
      ok: true,
      payload: { status: "ok" },
    });
    await expect(request).resolves.toEqual({ status: "ok" });
    await stopSyntheticClient(client);
  });

  test("clamps oversized tick watchdog intervals before scheduling", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { client } = createWatchedGatewayClient(Number.MAX_SAFE_INTEGER);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
    client.stop();
  });

  test("aborts in-flight requests from caller AbortSignal", async () => {
    const client = new GatewayClient({ requestTimeoutMs: 25 });
    const send = vi.fn();
    installSyntheticSocket(client, send, vi.fn());

    const controller = new AbortController();
    const requestPromise = client.request("status", undefined, {
      signal: controller.signal,
      timeoutMs: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(protocolHarness(client).hasPendingRequests).toBe(true);

    controller.abort();

    await expect(requestPromise).rejects.toThrow("gateway request aborted for status");
    expect(protocolHarness(client).hasPendingRequests).toBe(false);
  });

  test("clamps oversized stopAndWait timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({});
    const ws = { readyState: WebSocket.OPEN, close: vi.fn(), terminate: vi.fn() };
    (client as unknown as { ws: unknown }).ws = ws;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const stopPromise = client.stopAndWait({ timeoutMs: Number.MAX_SAFE_INTEGER });

    await vi.advanceTimersByTimeAsync(1);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);

    await vi.advanceTimersByTimeAsync(249);
    await expect(stopPromise).resolves.toBeUndefined();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
});
