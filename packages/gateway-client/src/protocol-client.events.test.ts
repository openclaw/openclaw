import type { EventFrame } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayProtocolClient, type GatewayProtocolSocketHandlers } from "./protocol-client.js";

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

describe("GatewayProtocolClient lifecycle and event delivery", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  test.each([
    { retirement: "event owner", firstListenerCalls: 0, method: "stop" },
    { retirement: "first direct listener", firstListenerCalls: 1, method: "stop" },
    { retirement: "event owner", firstListenerCalls: 0, method: "closeSocket" },
    { retirement: "first direct listener", firstListenerCalls: 1, method: "closeSocket" },
  ] as const)(
    "does not deliver a retired frame after the $retirement calls $method",
    ({ retirement, firstListenerCalls, method }) => {
      const onEvent = vi.fn(() => {
        if (retirement === "event owner") {
          client[method]();
        }
      });
      const firstListener = vi.fn(() => {
        if (retirement === "first direct listener") {
          client[method]();
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
      // A real WebSocket's close notification arrives after close() returns.
      connection.close.mockImplementation(() => {});

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
      client.stop();
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

  test.each(["final", "aborted", "error"])(
    "delivers a gap-revealing chat %s before recovery retires its socket",
    (state) => {
      const calls: string[] = [];
      const { client, connections } = createSyntheticGatewayProtocol({
        onEvent: () => calls.push("event"),
        onGap: () => {
          calls.push("gap");
          client.stop();
        },
      });
      client.addEventListener(() => calls.push("listener"));
      client.start();
      const connection = connections[0];
      if (!connection) {
        throw new Error("Expected a protocol connection");
      }
      connection.handlers.message(
        JSON.stringify({ type: "event", event: "board.changed", seq: 1, payload: {} }),
      );
      calls.length = 0;
      connection.handlers.message(
        JSON.stringify({
          type: "event",
          event: "chat",
          seq: 3,
          payload: { runId: "run", state, message: { role: "assistant", content: "complete" } },
        }),
      );
      expect(calls).toEqual(["event", "listener", "gap"]);
      expect(connection.close).toHaveBeenCalledOnce();
    },
  );

  test("reconnects and rejects append frames when gap recovery leaves the socket active", async () => {
    vi.useFakeTimers();
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
      event: "chat",
      payload: { runId: "run-1", state: "delta", deltaText: "lost-prefix suffix" },
      seq: 3,
    };

    connection.handlers.message(JSON.stringify(gapped));

    expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 2, received: 3 });
    expect(onEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledExactlyOnceWith(4000, "event sequence gap");

    const next = {
      type: "event" as const,
      event: "board.changed",
      payload: {},
      seq: 4,
    };
    connection.handlers.message(JSON.stringify(next));

    expect(onGap).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    const replacement = connections[1];
    if (!replacement) {
      throw new Error("synthetic gap recovery connection missing");
    }
    const baseline = {
      ...gapped,
      seq: 10,
      payload: {
        runId: "run-1",
        state: "delta",
        deltaText: "suffix",
        message: { role: "assistant", content: "complete prefix and suffix" },
      },
    };
    replacement.handlers.message(JSON.stringify(baseline));
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(baseline);
    expect(listener).toHaveBeenCalledExactlyOnceWith(baseline);
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
});
