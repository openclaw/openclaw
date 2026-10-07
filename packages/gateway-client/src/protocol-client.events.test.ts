import assert from "node:assert/strict";
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
      assert(connection);
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

  test.each(["stop", "replace", "reconnect"])(
    "drops gapped frames during %s recovery",
    async (recovery) => {
      vi.useFakeTimers();
      const onEvent = vi.fn();
      const listener = vi.fn();
      const onGap = vi.fn(() => {
        if (recovery !== "reconnect") {
          client.stop();
          if (recovery === "replace") {
            client.start();
          }
        }
      });
      const { client, connections } = createSyntheticGatewayProtocol({ onEvent, onGap });
      client.addEventListener(listener);
      client.start();
      const first = connections[0];
      assert(first);
      first.handlers.message(
        JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 1 }),
      );
      onEvent.mockClear();
      listener.mockClear();
      const gapped = {
        type: "event" as const,
        event: recovery === "reconnect" ? "chat" : "board.command",
        payload:
          recovery === "reconnect"
            ? { runId: "run-1", state: "delta", deltaText: "lost-prefix suffix" }
            : { command: "stale" },
        seq: 3,
      };
      first.handlers.message(JSON.stringify(gapped));
      expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 2, received: 3 });
      expect(onEvent).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(connections).toHaveLength(recovery === "replace" ? 2 : 1);
      if (recovery === "reconnect") {
        expect(first.close).toHaveBeenCalledExactlyOnceWith(4000, "event sequence gap");
        first.handlers.message(
          JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 4 }),
        );
        expect(onGap).toHaveBeenCalledOnce();
        expect(onEvent).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10);
      }
      if (recovery !== "stop") {
        const replacement = connections[1];
        assert(replacement);
        const fresh =
          recovery === "replace"
            ? { type: "event", event: "board.command", payload: { command: "current" }, seq: 2 }
            : {
                ...gapped,
                seq: 10,
                payload: {
                  runId: "run-1",
                  state: "delta",
                  deltaText: "suffix",
                  message: { role: "assistant", content: "complete prefix and suffix" },
                },
              };
        replacement.handlers.message(JSON.stringify(fresh));
        expect(onGap).toHaveBeenCalledOnce();
        expect(onEvent).toHaveBeenCalledExactlyOnceWith(fresh);
        expect(listener).toHaveBeenCalledExactlyOnceWith(fresh);
      }
      client.stop();
    },
  );

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
      assert(connection);
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

  test.each(["handshake", "request"])("keeps the active %s when started again", async (phase) => {
    const { client, connections } = createSyntheticGatewayProtocol();
    client.start();
    const connection = connections[0];
    assert(connection);
    if (phase === "request") {
      completeSyntheticGatewayProtocolHandshake(connection);
      await Promise.resolve();
    }
    const request =
      phase === "request"
        ? client.request<{ status: string }>("agent", undefined, {
            expectFinal: true,
            timeoutMs: null,
          })
        : undefined;
    client.start();
    expect(connections).toHaveLength(1);
    expect(connection.close).not.toHaveBeenCalled();
    if (request) {
      const frame = JSON.parse(String(connection.send.mock.calls.at(-1)?.[0])) as { id: string };
      connection.handlers.message(
        JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "ok" } }),
      );
      await expect(request).resolves.toEqual({ status: "ok" });
      expect(client.hasPendingRequests).toBe(false);
    }
    client.stop();
  });

  test.each(["none", "backoff", "stop"])(
    "preserves the scheduled reconnect after %s reset",
    async (reset) => {
      vi.useFakeTimers();
      const { client, connections } = createSyntheticGatewayProtocol();
      client.start();
      const first = connections[0];
      assert(first);
      first.close(1012, "first service restart");
      expect(vi.getTimerCount()).toBe(1);
      if (reset === "none") {
        client.start();
        expect(connections).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(9);
        expect(connections).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(connections).toHaveLength(2);
      } else {
        if (reset === "backoff") {
          client.resetReconnectBackoff(10);
        } else {
          client.stop();
        }
        client.start();
        expect(connections).toHaveLength(2);
        const second = connections[1];
        assert(second);
        second.close(1012, "second service restart");
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        client.start();
        expect(connections).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(connections).toHaveLength(3);
      }
      client.stop();
    },
  );

  test.each(["terminal close", "factory failure"])("allows manual restart after %s", (failure) => {
    vi.useFakeTimers();
    const { client, connections } = createSyntheticGatewayProtocol({
      retryOnClose: false,
      initialSocketFactoryFailures: failure === "factory failure" ? 1 : 0,
    });
    client.start();
    if (failure === "factory failure") {
      expect(connections).toHaveLength(0);
    } else {
      const connection = connections[0];
      assert(connection);
      connection.close(1008, "terminal close");
    }
    expect(vi.getTimerCount()).toBe(0);
    client.start();
    expect(connections).toHaveLength(failure === "factory failure" ? 1 : 2);
    expect(vi.getTimerCount()).toBe(0);
    client.stop();
  });
});
