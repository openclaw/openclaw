import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createProtocolHarness as createSyntheticGatewayProtocol,
  receive,
  stopProtocolClients,
} from "./protocol-client.test-support.js";

describe("GatewayProtocolClient lifecycle and event delivery", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    stopProtocolClients();
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

      receive(connection, {
        type: "event",
        event: "board.command",
        payload: { command: "retired" },
        seq: 1,
      });

      expect(onEvent).toHaveBeenCalledOnce();
      expect(firstListener).toHaveBeenCalledTimes(firstListenerCalls);
      expect(staleListener).not.toHaveBeenCalled();
      expect(connection.close).toHaveBeenCalledOnce();
    },
  );

  test("does not revive a removed subscription replaced with the same callback", () => {
    const listener = vi.fn();
    let removeListener = () => {};
    let isFirstEvent = true;
    const onEvent = vi.fn(() => {
      if (isFirstEvent) {
        isFirstEvent = false;
        removeListener();
        client.addEventListener(listener);
      }
    });
    const { client, connections } = createSyntheticGatewayProtocol({ onEvent });
    removeListener = client.addEventListener(listener);
    client.start();
    const connection = connections[0];
    if (!connection) {
      throw new Error("synthetic protocol connection missing");
    }

    receive(connection, { type: "event", event: "board.changed", payload: {}, seq: 1 });

    expect(listener).not.toHaveBeenCalled();

    receive(connection, { type: "event", event: "board.changed", payload: {}, seq: 2 });

    expect(listener).toHaveBeenCalledOnce();

    // Calling the retired subscription's disposer cannot remove its replacement.
    removeListener();
    receive(connection, { type: "event", event: "board.changed", payload: {}, seq: 3 });

    expect(listener).toHaveBeenCalledTimes(2);
  });

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
      receive(first, { type: "event", event: "board.changed", payload: {}, seq: 1 });
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
      receive(first, gapped);
      expect(onGap).toHaveBeenCalledExactlyOnceWith({ expected: 2, received: 3 });
      expect(onEvent).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(connections).toHaveLength(recovery === "replace" ? 2 : 1);
      if (recovery === "reconnect") {
        expect(first.close).toHaveBeenCalledExactlyOnceWith(4000, "event sequence gap");
        receive(first, { type: "event", event: "board.changed", payload: {}, seq: 4 });
        expect(onGap).toHaveBeenCalledOnce();
        expect(onEvent).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10);
      }
      {
        receive(first, { type: "event", event: "board.changed", payload: {}, seq: 10 });
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
        receive(replacement, fresh);
        expect(onGap).toHaveBeenCalledOnce();
        expect(onEvent).toHaveBeenCalledExactlyOnceWith(fresh);
        expect(listener).toHaveBeenCalledExactlyOnceWith(fresh);
      }
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
    receive(connection, { type: "event", event: "board.changed", seq: 1, payload: {} });
    calls.length = 0;
    receive(connection, {
      type: "event",
      event: "chat",
      seq: 3,
      payload: {
        runId: "run",
        state: "aborted",
        message: { role: "assistant", content: "complete" },
      },
    });
    expect(calls).toEqual(["event", "listener", "gap"]);
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
