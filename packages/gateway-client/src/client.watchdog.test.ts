import { createServer } from "node:net";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import { GatewayClient } from "./client.js";
import {
  GatewayProtocolClient,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "./timeouts.js";
import { rawDataToString } from "./websocket-data.js";
import { WebSocket, WebSocketServer } from "./websocket.test-support.js";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function createOpenGatewayClient(requestTimeoutMs: number): {
  client: GatewayClient;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs,
  });
  const send = vi.fn();
  installSyntheticSocket(client, send, vi.fn());
  return { client, send };
}

function hasPendingRequests(client: GatewayClient): boolean {
  return protocolHarness(client).hasPendingRequests;
}

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

function trackSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

function createWatchedGatewayClient(): {
  client: GatewayClient;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs: 100,
    tickWatchMinIntervalMs: 5,
    tickWatchTimeoutMs: 10,
  });
  const close = vi.fn();
  const send = vi.fn();
  installSyntheticSocket(client, send, close);
  Object.assign(client as unknown as { tickIntervalMs: number; lastTick: number }, {
    tickIntervalMs: 5,
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

type SyntheticGatewayProtocolConnection = {
  handlers: GatewayProtocolSocketHandlers;
  send: ReturnType<typeof vi.fn<(data: string) => void>>;
  close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>;
};

function createSyntheticGatewayProtocol(options?: {
  retryOnClose?: boolean;
  initialSocketFactoryFailures?: number;
  onEvent?: (event: EventFrame) => void;
  onGap?: (info: { expected: number; received: number }) => void;
}): {
  client: GatewayProtocolClient<Record<string, never>>;
  connections: SyntheticGatewayProtocolConnection[];
} {
  const connections: SyntheticGatewayProtocolConnection[] = [];
  let nextRequestId = 0;
  let remainingSocketFactoryFailures = options?.initialSocketFactoryFailures ?? 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      if (remainingSocketFactoryFailures > 0) {
        remainingSocketFactoryFailures -= 1;
        throw new Error("synthetic socket factory failure");
      }
      let open = true;
      const send = vi.fn<(data: string) => void>();
      const close = vi.fn<(code?: number, reason?: string) => void>((code, reason) => {
        open = false;
        handlers.close(code ?? 1000, reason ?? "");
      });
      connections.push({ handlers, send, close });
      return {
        isOpen: () => open,
        send: (data) => send(data),
        close: (code, reason) => close(code, reason),
      };
    },
    createRequestId: () => `request-${++nextRequestId}`,
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: options?.retryOnClose ?? true, notify: true }),
    onEvent: options?.onEvent,
    onGap: options?.onGap,
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  return { client, connections };
}

function completeSyntheticGatewayProtocolHandshake(
  connection: SyntheticGatewayProtocolConnection,
): void {
  connection.handlers.open();
  connection.handlers.message(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-nonce", ts: 1_777_777_777_000 },
    }),
  );
  const connectFrame = JSON.parse(String(connection.send.mock.calls[0]?.[0])) as {
    id: string;
  };
  connection.handlers.message(
    JSON.stringify({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: { type: "hello-ok" },
    }),
  );
}

describe("GatewayClient", () => {
  let wss: WebSocketServer | null = null;

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(async () => {
    // Timer spies must restore their fake functions before the clock uninstalls them.
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss?.close(() => resolve());
      });
      wss = null;
    }
  });

  test.each([
    { retirement: "event owner", firstListenerCalls: 0 },
    { retirement: "first direct listener", firstListenerCalls: 1 },
  ])(
    "does not deliver a retired frame after the $retirement closes its socket",
    ({ retirement, firstListenerCalls }) => {
      const onEvent = vi.fn(() => {
        if (retirement === "event owner") {
          client.stop();
        }
      });
      const firstListener = vi.fn(() => {
        if (retirement === "first direct listener") {
          client.stop();
        }
      });
      const staleListener = vi.fn();
      const { client, connections } = createSyntheticGatewayProtocol({ onEvent });
      client.addEventListener(firstListener);
      client.addEventListener(staleListener);
      client.start();
      const connection = connections[0];
      if (!connection) {
        throw new Error("synthetic protocol connection missing");
      }

      connection.handlers.message(
        JSON.stringify({
          type: "event",
          event: "board.command",
          payload: { command: "retired" },
          seq: 1,
        }),
      );

      expect(onEvent).toHaveBeenCalledOnce();
      expect(firstListener).toHaveBeenCalledTimes(firstListenerCalls);
      expect(staleListener).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalledOnce();
    },
  );

  test.each([
    { replacement: "a new callback", reuseCallback: false },
    { replacement: "the same callback", reuseCallback: true },
  ])("does not revive a removed subscription replaced with $replacement", ({ reuseCallback }) => {
    const removedListener = vi.fn();
    const addedListener = reuseCallback ? removedListener : vi.fn();
    let removeListener = () => {};
    let isFirstEvent = true;
    const onEvent = vi.fn(() => {
      if (isFirstEvent) {
        isFirstEvent = false;
        removeListener();
        client.addEventListener(addedListener);
      }
    });
    const { client, connections } = createSyntheticGatewayProtocol({ onEvent });
    removeListener = client.addEventListener(removedListener);
    client.start();
    const connection = connections[0];
    if (!connection) {
      throw new Error("synthetic protocol connection missing");
    }

    connection.handlers.message(
      JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 1 }),
    );

    expect(removedListener).not.toHaveBeenCalled();
    expect(addedListener).not.toHaveBeenCalled();

    connection.handlers.message(
      JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 2 }),
    );

    expect(addedListener).toHaveBeenCalledOnce();
    if (!reuseCallback) {
      expect(removedListener).not.toHaveBeenCalled();
    }

    // Calling the retired subscription's disposer cannot remove its replacement.
    removeListener();
    connection.handlers.message(
      JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 3 }),
    );

    expect(addedListener).toHaveBeenCalledTimes(2);
    client.stop();
  });

  test.each([
    { recovery: "stops the socket", restart: false },
    { recovery: "replaces the socket", restart: true },
  ])("drops a gapped frame when recovery $recovery", ({ restart }) => {
    const onEvent = vi.fn();
    const listener = vi.fn();
    const onGap = vi.fn(() => {
      client.stop();
      if (restart) {
        client.start();
      }
    });
    const { client, connections } = createSyntheticGatewayProtocol({ onEvent, onGap });
    client.addEventListener(listener);
    client.start();
    const first = connections[0];
    if (!first) {
      throw new Error("synthetic protocol connection missing");
    }
    first.handlers.message(
      JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 1 }),
    );
    onEvent.mockClear();
    listener.mockClear();

    first.handlers.message(
      JSON.stringify({
        type: "event",
        event: "board.command",
        payload: { command: "stale" },
        seq: 3,
      }),
    );

    expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 2, received: 3 });
    expect(onEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(connections).toHaveLength(restart ? 2 : 1);

    if (restart) {
      const replacement = connections[1];
      if (!replacement) {
        throw new Error("synthetic replacement protocol connection missing");
      }
      const fresh = {
        type: "event" as const,
        event: "board.command",
        payload: { command: "current" },
        seq: 2,
      };
      replacement.handlers.message(JSON.stringify(fresh));

      expect(onGap).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledExactlyOnceWith(fresh);
      expect(listener).toHaveBeenCalledExactlyOnceWith(fresh);
    }

    client.stop();
  });

  test("delivers a gapped frame when gap recovery retains the active socket", () => {
    const onEvent = vi.fn();
    const onGap = vi.fn();
    const listener = vi.fn();
    const { client, connections } = createSyntheticGatewayProtocol({ onEvent, onGap });
    client.addEventListener(listener);
    client.start();
    const connection = connections[0];
    if (!connection) {
      throw new Error("synthetic protocol connection missing");
    }
    connection.handlers.message(
      JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 1 }),
    );
    onEvent.mockClear();
    listener.mockClear();
    const gapped = {
      type: "event" as const,
      event: "board.command",
      payload: { command: "current" },
      seq: 3,
    };

    connection.handlers.message(JSON.stringify(gapped));

    expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 2, received: 3 });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(gapped);
    expect(listener).toHaveBeenCalledExactlyOnceWith(gapped);

    const next = {
      type: "event" as const,
      event: "board.changed",
      payload: {},
      seq: 4,
    };
    connection.handlers.message(JSON.stringify(next));

    expect(onGap).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenLastCalledWith(next);
    expect(listener).toHaveBeenLastCalledWith(next);
    client.stop();
  });

  test("keeps one socket when the protocol is started twice during its handshake", () => {
    const { client, connections } = createSyntheticGatewayProtocol();

    client.start();
    client.start();

    expect(connections).toHaveLength(1);
    expect(connections[0]?.close).not.toHaveBeenCalled();
    client.stop();
  });

  test("settles the original unbounded request when an active protocol is started again", async () => {
    const { client, connections } = createSyntheticGatewayProtocol();
    client.start();
    const connection = connections[0];
    if (!connection) {
      throw new Error("synthetic protocol connection missing");
    }
    completeSyntheticGatewayProtocolHandshake(connection);
    await Promise.resolve();

    const request = client.request<{ status: string }>("agent", undefined, {
      expectFinal: true,
      timeoutMs: null,
    });
    const frame = JSON.parse(String(connection.send.mock.calls.at(-1)?.[0])) as { id: string };
    client.start();

    expect(connections).toHaveLength(1);
    connection.handlers.message(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { status: "ok" },
      }),
    );

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(client.hasPendingRequests).toBe(false);
    client.stop();
  });

  test("preserves the one scheduled reconnect when the running protocol is started again", async () => {
    vi.useFakeTimers();
    const { client, connections } = createSyntheticGatewayProtocol();
    client.start();
    const connection = connections[0];
    if (!connection) {
      throw new Error("synthetic protocol connection missing");
    }

    connection.close(1012, "service restart");
    expect(vi.getTimerCount()).toBe(1);
    client.start();

    expect(connections).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connections).toHaveLength(2);
    client.stop();
  });

  test("restarts immediately after resetting a pending reconnect", async () => {
    vi.useFakeTimers();
    const { client, connections } = createSyntheticGatewayProtocol();
    client.start();
    const firstConnection = connections[0];
    if (!firstConnection) {
      throw new Error("synthetic protocol connection missing");
    }

    firstConnection.close(1012, "first service restart");
    expect(vi.getTimerCount()).toBe(1);
    client.resetReconnectBackoff(10);
    client.start();

    expect(connections).toHaveLength(2);
    const secondConnection = connections[1];
    if (!secondConnection) {
      throw new Error("synthetic replacement connection missing");
    }
    secondConnection.close(1012, "second service restart");

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    client.start();
    expect(connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(connections).toHaveLength(3);
    client.stop();
  });

  test("allows manual restart after a terminal socket close", () => {
    vi.useFakeTimers();
    const { client, connections } = createSyntheticGatewayProtocol({ retryOnClose: false });
    client.start();
    const connection = connections[0];
    if (!connection) {
      throw new Error("synthetic protocol connection missing");
    }

    connection.close(1008, "terminal close");
    expect(vi.getTimerCount()).toBe(0);
    client.start();

    expect(connections).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });

  test("allows manual restart after a socket factory failure", () => {
    const { client, connections } = createSyntheticGatewayProtocol({
      initialSocketFactoryFailures: 1,
    });

    client.start();
    expect(connections).toHaveLength(0);
    client.start();

    expect(connections).toHaveLength(1);
    client.stop();
  });

  test("does not let a canceled retry clear the next scheduled reconnect", async () => {
    vi.useFakeTimers();
    const { client, connections } = createSyntheticGatewayProtocol();
    client.start();
    const firstConnection = connections[0];
    if (!firstConnection) {
      throw new Error("synthetic protocol connection missing");
    }

    firstConnection.close(1012, "first service restart");
    client.stop();
    client.start();
    const secondConnection = connections[1];
    if (!secondConnection) {
      throw new Error("synthetic replacement connection missing");
    }
    secondConnection.close(1012, "second service restart");

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    client.start();
    expect(connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10);

    expect(connections).toHaveLength(3);
    client.stop();
  });

  test("sends the configured websocket origin", async () => {
    const port = await getFreePort();
    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    const receivedOrigin = new Promise<string | undefined>((resolve) => {
      wss?.once("connection", (_socket, request) => resolve(request.headers.origin));
    });
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      connectChallengeTimeoutMs: 0,
    });
    client.start();

    await expect(receivedOrigin).resolves.toBe(`http://127.0.0.1:${port}`);
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

    client.updateNodeManifest({
      caps: ["canvas", "system"],
      commands: ["canvas.present", "system.run"],
      workerRuns: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.12",
        protocolFeatures: ["worker-heartbeat-v1"],
      },
    });

    expect(close).toHaveBeenCalledWith(1012, "node manifest changed");
    expect((client as unknown as { opts: Record<string, unknown> }).opts).toMatchObject({
      caps: ["canvas", "system"],
      commands: ["canvas.present", "system.run"],
      workerRuns: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.12",
        protocolFeatures: ["worker-heartbeat-v1"],
      },
    });
  });

  test("rejects an unbounded request, reconnects, and does not replay it", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss = server;
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("websocket server address unavailable");
    }

    let connectionCount = 0;
    const methodsByConnection = new Map<number, string[]>();
    server.on("connection", (socket) => {
      connectionCount += 1;
      const connectionNumber = connectionCount;
      methodsByConnection.set(connectionNumber, []);
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          seq: connectionNumber,
          payload: { nonce: `nonce-${connectionNumber}`, ts: 1_777_777_777_000 },
        }),
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
        methodsByConnection.get(connectionNumber)?.push(frame.method);
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                server: { version: "watchdog-test", connId: `c${connectionNumber}` },
                features: { methods: ["chat.send", "status"], events: ["tick"] },
                snapshot: {
                  presence: [],
                  health: {},
                  stateVersion: { presence: 1, health: 1 },
                  uptimeMs: 1,
                },
                auth: { role: "operator", scopes: ["operator.admin"] },
                policy: {
                  maxPayload: 512 * 1024,
                  maxBufferedBytes: 1024 * 1024,
                  tickIntervalMs: 20,
                },
              },
            }),
          );
          return;
        }
        if (frame.method === "status") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { status: "ok" },
            }),
          );
        }
      });
    });

    const firstHelloResolvers: Array<() => void> = [];
    const secondHelloResolvers: Array<() => void> = [];
    const firstHello = new Promise<void>((resolve) => {
      firstHelloResolvers.push(resolve);
    });
    const secondHello = new Promise<void>((resolve) => {
      secondHelloResolvers.push(resolve);
    });
    const resolveFirstHello = firstHelloResolvers.at(0);
    const resolveSecondHello = secondHelloResolvers.at(0);
    if (!resolveFirstHello || !resolveSecondHello) {
      throw new Error("hello promises did not initialize their resolvers");
    }
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let helloCount = 0;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${address.port}`,
      tickWatchMinIntervalMs: 5,
      onHelloOk: () => {
        helloCount += 1;
        if (helloCount === 1) {
          // Keep the real reconnect lifecycle fast without changing production defaults.
          protocolHarness(client).reconnectSupervisor.reset(10);
          resolveFirstHello();
          return;
        }
        resolveSecondHello();
      },
      onClose: (code, reason) => closeEvents.push({ code, reason }),
    });

    try {
      client.start();
      await firstHello;

      const stalledRequest = client.request(
        "chat.send",
        { text: "send once" },
        {
          expectFinal: true,
        },
      );
      void stalledRequest.catch(() => {});

      await expect(stalledRequest).rejects.toThrow("gateway closed (4000): tick timeout");
      await secondHello;
      await expect(client.request("status")).resolves.toEqual({ status: "ok" });

      expect(closeEvents[0]).toEqual({ code: 4000, reason: "tick timeout" });
      expect(methodsByConnection.get(1)).toEqual(["connect", "chat.send"]);
      expect(methodsByConnection.get(2)).toEqual(["connect", "status"]);
      expect(
        [...methodsByConnection.values()].flat().filter((method) => method === "chat.send"),
      ).toHaveLength(1);
    } finally {
      await client.stopAndWait();
    }
  }, 5000);

  test("lets finite pending requests own their timeout when ticks are missing", async () => {
    vi.useFakeTimers();
    const { client, close } = createWatchedGatewayClient();
    const request = client.request("status", undefined, { timeoutMs: 100 });
    const requestExpectation = expect(request).rejects.toThrow(
      "gateway request timeout for status",
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(80);
    await requestExpectation;
    await vi.advanceTimersByTimeAsync(5);

    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    await stopSyntheticClient(client);
  });

  test.each([
    {
      label: "an explicit timeoutMs: null",
      method: "status",
      options: { timeoutMs: null },
    },
    {
      label: "an implicit expectFinal",
      method: "chat.send",
      options: { expectFinal: true },
    },
  ])("keeps the watchdog active for $label request", async ({ method, options }) => {
    vi.useFakeTimers();
    const { client, close } = createWatchedGatewayClient();
    const request = client.request(method, undefined, options);
    const requestExpectation = expect(request).rejects.toThrow("gateway client stopped");

    await vi.advanceTimersByTimeAsync(20);

    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
    await stopSyntheticClient(client);
    await requestExpectation;
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

  test("honors explicit tick watchdog timeout threshold", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({
      tickWatchMinIntervalMs: 5,
      tickWatchTimeoutMs: 50,
    });
    const close = vi.fn();
    installSyntheticSocket(client, vi.fn(), close);
    Object.assign(client as unknown as { tickIntervalMs: number; lastTick: number }, {
      tickIntervalMs: 5,
      lastTick: Date.now(),
    });

    (
      client as unknown as {
        startTickWatch: () => void;
      }
    ).startTickWatch();
    await vi.advanceTimersByTimeAsync(20);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(35);
    expect(close).toHaveBeenCalledWith(4000, "tick timeout");
  });

  test("clamps oversized tick watchdog intervals before scheduling", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const client = new GatewayClient({
      tickWatchMinIntervalMs: 5,
    });
    Object.assign(client as unknown as { ws: unknown; tickIntervalMs: number; lastTick: number }, {
      ws: {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
      },
      tickIntervalMs: Number.MAX_SAFE_INTEGER,
      lastTick: Date.now(),
    });

    (
      client as unknown as {
        startTickWatch: () => void;
      }
    ).startTickWatch();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
    client.stop();
  });

  test("aborts in-flight requests from caller AbortSignal", async () => {
    const { client, send } = createOpenGatewayClient(25);

    const controller = new AbortController();
    const requestPromise = client.request("status", undefined, {
      signal: controller.signal,
      timeoutMs: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(hasPendingRequests(client)).toBe(true);

    controller.abort();

    await expect(requestPromise).rejects.toThrow("gateway request aborted for status");
    expect(hasPendingRequests(client)).toBe(false);
  });

  test.each([
    { defaultTimeoutMs: 25, options: { timeoutMs: 2_592_010_000 } },
    { defaultTimeoutMs: 2_592_010_000, options: undefined },
  ])(
    "clamps oversized request timeouts before scheduling",
    async ({ defaultTimeoutMs, options }) => {
      vi.useFakeTimers();
      const { client } = createOpenGatewayClient(defaultTimeoutMs);

      const requestPromise = client.request("status", undefined, options);
      const isSettled = trackSettlement(requestPromise);

      await vi.advanceTimersByTimeAsync(1);

      expect(isSettled()).toBe(false);
      expect(hasPendingRequests(client)).toBe(true);

      client.stop();
      await expect(requestPromise).rejects.toThrow("gateway client stopped");
    },
  );

  test("clamps oversized stopAndWait timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({});
    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      terminate: vi.fn(),
    };
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
