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
  onEvent?: (event: EventFrame) => void;
  onGap?: (info: { expected: number; received: number }) => void;
}): {
  client: GatewayProtocolClient<Record<string, never>>;
  connections: SyntheticGatewayProtocolConnection[];
} {
  const connections: SyntheticGatewayProtocolConnection[] = [];
  let nextRequestId = 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
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
    resolveClose: () => ({ retry: true, notify: true }),
    onEvent: options?.onEvent,
    onGap: options?.onGap,
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  return { client, connections };
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

  test.each([{ replacement: "the same callback", reuseCallback: true }])(
    "does not revive a removed subscription replaced with $replacement",
    ({ reuseCallback }) => {
      const removedListener = vi.fn();
      const addedListener = removedListener;
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
    },
  );

  test.each(["replace", "reconnect"])(
    "drops gapped frames during %s recovery",
    async (recovery) => {
      vi.useFakeTimers();
      const onEvent = vi.fn();
      const listener = vi.fn();
      const onGap = vi.fn(() => {
        if (recovery !== "reconnect") {
          client.stop();
          client.start();
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
      {
        first.handlers.message(
          JSON.stringify({ type: "event", event: "board.changed", payload: {}, seq: 10 }),
        );
        expect(onEvent).not.toHaveBeenCalled();
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

  test("delivers a gap-revealing chat abort before recovery retires its socket", () => {
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
        payload: {
          runId: "run",
          state: "aborted",
          message: { role: "assistant", content: "complete" },
        },
      }),
    );
    expect(calls).toEqual(["event", "listener", "gap"]);
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
