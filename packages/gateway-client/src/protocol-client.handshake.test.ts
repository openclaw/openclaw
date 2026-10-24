import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import type { GatewayProtocolSocket, GatewayProtocolSocketHandlers } from "./protocol-client.js";
import {
  createProtocolClient,
  createProtocolHarness,
  startProtocolHarness,
  receive,
  respond,
  challenge as receiveConnectChallenge,
  stopProtocolClients,
  type Connection,
} from "./protocol-client.test-support.js";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "./timeouts.js";

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.useFakeTimers();
});
afterEach(() => {
  stopProtocolClients();
  for (const client of nodeClients.splice(0)) {
    client.stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createHandshakeClient(
  buildConnectPlan: () => Record<string, never> | Promise<Record<string, never>> = () => ({}),
  delayClose = false,
) {
  const spies = {
    onHello: vi.fn(),
    onConnectHello: vi.fn(() => ({ ignored: true })),
    onClose: vi.fn(),
    onTiming: vi.fn(),
    onReconnectScheduled: vi.fn<(delayMs: number, signal: AbortSignal) => void>(),
  };
  const {
    client,
    connections,
    connection: first,
  } = startProtocolHarness({ buildConnectPlan, ...spies }, { delayClose });
  return { client, connections, first, ...spies };
}

function receiveHello(connection: Connection): void {
  const frame = connection.frames[0];
  assert(frame);
  respond(connection, frame.id, { type: "hello-ok" });
}

describe("GatewayProtocolClient connect handshake", () => {
  it.each([{ retryable: true, retryAfterMs: 90_000, delayMs: 99_000, draw: 0.5, nextDelayMs: 22 }])(
    "keeps admitted retry timing while advancing backoff: %j",
    async ({ retryable, retryAfterMs, delayMs, draw, nextDelayMs }) => {
      vi.mocked(Math.random).mockReturnValue(draw);
      const { connections, onReconnectScheduled, first } = createHandshakeClient();

      receiveConnectChallenge(first);
      const sent = first.send.mock.calls[0];
      assert(sent);
      const request = JSON.parse(sent[0]) as { id: string };
      receive(first, {
        type: "res",
        id: request.id,
        ok: false,
        error: { code: "UNAVAILABLE", message: "temporarily unavailable", retryable, retryAfterMs },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(onReconnectScheduled).toHaveBeenCalledExactlyOnceWith(
        delayMs,
        expect.any(AbortSignal),
      );
      const signal = onReconnectScheduled.mock.calls[0]?.[1];
      assert(signal);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(connections).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toHaveLength(2);

      const second = connections[1];
      assert(second);
      second.close(1006, "transport unavailable");
      expect(signal.aborted).toBe(true);
      expect(onReconnectScheduled).toHaveBeenLastCalledWith(nextDelayMs, expect.any(AbortSignal));
      await vi.advanceTimersByTimeAsync(nextDelayMs - 1);
      expect(connections).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toHaveLength(3);
    },
  );

  it.each([false, true])(
    "cancels a scheduled retry when its observer stops the client (restart=%s)",
    async (restart) => {
      const { client, connections, onReconnectScheduled, first } = createHandshakeClient();
      let timersAtNotification = 0;
      onReconnectScheduled.mockImplementation(() => {
        timersAtNotification = vi.getTimerCount();
        client.stop();
        if (restart) {
          client.start();
        }
      });

      first.close(1006, "transport unavailable");
      expect(onReconnectScheduled).toHaveBeenCalledOnce();
      expect(timersAtNotification).toBe(1);
      expect(onReconnectScheduled.mock.calls[0]?.[1].aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(connections).toHaveLength(restart ? 2 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["before response", "before publication"])(
    "rejects hello when the connect deadline closes the transport %s",
    async (closingOrder) => {
      const { client, connections, onHello, onConnectHello, onClose, onTiming, first } =
        createHandshakeClient(undefined, true);

      first.close(1012, "restart");
      first.handlers.close(1012, "restart");
      await vi.advanceTimersByTimeAsync(10);
      const connection = connections[1];
      assert(connection);
      receiveConnectChallenge(connection);
      const pending = client.request("status").catch((error: unknown) => error);

      if (closingOrder === "before publication") {
        receiveHello(connection);
      }
      // Keep promise publication queued until the deadline closes the transport.
      vi.advanceTimersByTime(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
      expect(connection.close).toHaveBeenCalledExactlyOnceWith(4000, "connect timeout");
      if (closingOrder === "before response") {
        receiveHello(connection);
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(client).toMatchObject({ connected: false, connecting: true });
      expect(onHello).not.toHaveBeenCalled();
      expect(onConnectHello).not.toHaveBeenCalled();
      expect(onTiming.mock.calls.some(([timing]) => timing.phase === "hello")).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(client.hasPendingRequests).toBe(true);
      const onSent = vi.fn();
      await expect(client.request("status", undefined, { onSent })).rejects.toThrow(
        "gateway not connected",
      );
      expect(onSent).not.toHaveBeenCalled();

      connection.handlers.close(4000, "connect timeout");
      await expect(pending).resolves.toEqual(new Error("gateway closed (4000): connect timeout"));
      expect(client.hasPendingRequests).toBe(false);
      expect(onClose).toHaveBeenLastCalledWith(
        expect.objectContaining({ helloReceived: false, connectRequestSent: true }),
        { retry: true, notify: true },
      );
      // An unusable hello must not reset the second retry's exponential delay.
      await vi.advanceTimersByTimeAsync(10);
      expect(connections).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10);
      const replacement = connections[2];
      assert(replacement);
      receiveConnectChallenge(replacement);
      receiveHello(replacement);
      await vi.advanceTimersByTimeAsync(0);
      expect(onHello).toHaveBeenCalledExactlyOnceWith({ type: "hello-ok" });
      expect(onConnectHello).toHaveBeenCalledOnce();
      expect(client).toMatchObject({ connecting: false, connected: true });
      await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
      expect(replacement.close).not.toHaveBeenCalled();
      replacement.close(1012, "restart");
      replacement.handlers.close(1012, "restart");
      await vi.advanceTimersByTimeAsync(10);
      expect(connections).toHaveLength(4);
    },
  );

  it.each([false, true])("suppresses a resolved hello after stop (restart=%s)", async (restart) => {
    const {
      client,
      connections,
      onHello,
      onConnectHello,
      first: connection,
    } = createHandshakeClient();

    receiveConnectChallenge(connection);
    receiveHello(connection);
    client.stop();
    if (restart) {
      client.start();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(onHello).not.toHaveBeenCalled();
    expect(onConnectHello).not.toHaveBeenCalled();
    if (restart) {
      const replacement = connections[1];
      assert(replacement);
      receiveConnectChallenge(replacement);
      receiveHello(replacement);
      await vi.advanceTimersByTimeAsync(0);
      expect(onHello).toHaveBeenCalledOnce();
    }
  });

  it("does not retain an advertised capability after reconnecting to a different Gateway", async () => {
    const buildConnectPlan = vi.fn(() => ({}));
    const { connections, first } = createHandshakeClient(buildConnectPlan);

    first.handlers.open();
    receive(first, {
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "first", ts: 1, capabilities: ["model-catalog-snapshot"] },
    });
    expect(buildConnectPlan).toHaveBeenLastCalledWith({
      nonce: "first",
      challengeTs: 1,
      serverCapabilities: ["model-catalog-snapshot"],
      generation: 1,
      signal: expect.any(AbortSignal),
      assertCurrent: expect.any(Function),
    });
    first.handlers.close(1006, "reconnect");
    await vi.advanceTimersByTimeAsync(10);
    const second = connections[1];
    assert.ok(second);
    receiveConnectChallenge(second);
    expect(buildConnectPlan).toHaveBeenLastCalledWith({
      nonce: "synthetic-nonce",
      challengeTs: 1_800_000_000_000,
      serverCapabilities: [],
      generation: 2,
      signal: expect.any(AbortSignal),
      assertCurrent: expect.any(Function),
    });
  });

  it.each([{ nonce: "legacy-nonce" }, { nonce: "malformed-nonce", ts: "not-a-number" }])(
    "marks an invalid challenge timestamp as null: %j",
    (payload) => {
      const buildConnectPlan = vi.fn(() => ({}));
      const { first } = createHandshakeClient(buildConnectPlan);

      first.handlers.open();
      receive(first, { type: "event", event: "connect.challenge", payload });
      expect(buildConnectPlan).toHaveBeenLastCalledWith({
        nonce: payload.nonce,
        challengeTs: null,
        serverCapabilities: [],
        generation: 1,
        signal: expect.any(AbortSignal),
        assertCurrent: expect.any(Function),
      });
    },
  );

  it("retires device preparation that outlives the connect handshake", async () => {
    const plan = createDeferred<Record<string, never>>();
    const { first: connection } = createHandshakeClient(() => plan.promise);

    receiveConnectChallenge(connection);
    expect(connection.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(connection.close).toHaveBeenCalledWith(4000, "connect timeout");
    plan.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.send).not.toHaveBeenCalled();
  });
});

function createSocketFactoryHarness(
  options?: Partial<GatewayProtocolClientOptions<Record<string, never>>> & {
    initialFailures?: number;
  },
) {
  let remainingFailures = options?.initialFailures ?? 0;
  const onConnectError = vi.fn<(error: Error) => void>((error) => options?.onConnectError?.(error));
  const createSocket = vi.fn<(handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket>(
    () => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("temporary socket construction failure");
      }
      return {
        isOpen: () => true,
        send: vi.fn(),
        close: vi.fn(),
      };
    },
  );
  const client = createProtocolClient({ ...options, createSocket, onConnectError });
  return { client, createSocket, onConnectError };
}

const nodeClients: GatewayClient[] = [];
function createNodeClient(options: GatewayClientOptions) {
  const onConnectError = vi.fn<(error: Error) => void>();
  const client = new GatewayClient({ url: "ws://127.0.0.1:18789", ...options, onConnectError });
  nodeClients.push(client);
  return { client, onConnectError };
}

describe("GatewayProtocolClient socket factory recovery", () => {
  it.each([{ draw: 0.5, delays: [11, 22, 44, 88, 92, 92], resetDelay: 28 }])(
    "spreads exponential retries through the cap and reset ($draw)",
    async ({ draw, delays, resetDelay }) => {
      vi.mocked(Math.random).mockReturnValue(draw);
      const { client, createSocket, onConnectError } = createSocketFactoryHarness({
        initialFailures: delays.length,
        shouldRetrySocketFactoryError: () => true,
      });

      client.start();

      expect(createSocket).toHaveBeenCalledOnce();
      expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "temporary socket construction failure" }),
      );
      expect(vi.getTimerCount()).toBe(1);

      client.start();
      expect(createSocket).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);

      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(createSocket).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(createSocket).toHaveBeenCalledTimes(index + 2);
      }
      expect(onConnectError).toHaveBeenCalledTimes(delays.length);
      expect(client.connected).toBe(true);

      client.resetReconnectBackoff(25);
      createSocket.mock.calls.at(-1)?.[0].close(1012, "service restart");
      await vi.advanceTimersByTimeAsync(resetDelay - 1);
      expect(createSocket).toHaveBeenCalledTimes(delays.length + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(createSocket).toHaveBeenCalledTimes(delays.length + 2);
    },
  );

  it.each([false, true])(
    "does not retry after an error callback takes ownership (restart=%s)",
    async (restart) => {
      const { client, createSocket } = createSocketFactoryHarness({
        initialFailures: 1,
        onConnectError: () => (restart ? client.start() : client.stop()),
        shouldRetrySocketFactoryError: () => true,
      });
      client.start();
      expect(createSocket).toHaveBeenCalledTimes(restart ? 2 : 1);
      expect(vi.getTimerCount()).toBe(0);
      expect(client.connected).toBe(restart);
      await vi.advanceTimersByTimeAsync(100);
      expect(createSocket).toHaveBeenCalledTimes(restart ? 2 : 1);
      expect(client.connected).toBe(restart);
    },
  );

  it("retires requests and authority before a synchronous close callback restarts the socket", async () => {
    let recoveredRequest: Promise<{ healthy: boolean }> | undefined;
    let connectionSignal: AbortSignal | undefined;
    const onReconnectScheduled = vi.fn();
    const onClose = vi.fn(() => {
      expect(connectionSignal?.aborted).toBe(true);
      expect(client.connected).toBe(false);
      expect(client.hasPendingRequests).toBe(false);
      client.start();
      recoveredRequest = client.request("sessions.list", {}, { timeoutMs: null });
    });
    const { client, connections } = createProtocolHarness({
      buildConnectPlan: ({ signal }) => {
        connectionSignal = signal;
        return {};
      },
      onReconnectScheduled,
      onClose,
    });

    client.start();
    const first = connections[0];
    assert(first);
    first.handlers.open();
    receive(first, { type: "event", event: "connect.challenge", payload: { nonce: "challenge" } });
    const connect = first.frames[0];
    assert(connect);
    receive(first, {
      type: "res",
      id: connect.id,
      ok: true,
      payload: { type: "hello-ok" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const pending = client
      .request("before-close", {}, { timeoutMs: null })
      .catch((error: unknown) => error);

    client.closeSocket(1012, "service restart");

    expect(onClose).toHaveBeenCalledOnce();
    expect(await pending).toEqual(new Error("gateway closed (1012): service restart"));
    expect(connections).toHaveLength(2);
    expect(client.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(onReconnectScheduled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(connections).toHaveLength(2);

    const replacement = connections[1];
    assert(replacement);
    const request = replacement.frames[0];
    assert(request);
    receive(replacement, {
      type: "res",
      id: request.id,
      ok: true,
      payload: { healthy: true },
    });
    await expect(recoveredRequest).resolves.toEqual({ healthy: true });
    expect(client.hasPendingRequests).toBe(false);
  });

  it.each([true, false])(
    "contains a terminal asynchronous reconnect failure (rethrow: %s)",
    async (rethrow) => {
      const onCallbackError = vi.fn<(label: string, error: unknown) => void>();
      const onReconnectStopped = vi.fn<(error: Error) => void>();
      const { client, createSocket, onConnectError } = createSocketFactoryHarness({
        onCallbackError,
        onReconnectStopped,
        shouldRetrySocketFactoryError: () => rethrow,
        rethrowSocketFactoryError: () => rethrow,
      });
      client.start();
      createSocket.mockImplementationOnce(() => {
        throw new Error("loopback proxy policy rejected");
      });
      createSocket.mock.calls[0]?.[0].close(1012, "service restart");

      await vi.advanceTimersByTimeAsync(10);

      expect(createSocket).toHaveBeenCalledTimes(2);
      expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "loopback proxy policy rejected" }),
      );
      if (rethrow) {
        expect(onCallbackError).toHaveBeenCalledExactlyOnceWith(
          "reconnect",
          expect.objectContaining({ message: "loopback proxy policy rejected" }),
        );
      } else {
        expect(onCallbackError).not.toHaveBeenCalled();
      }
      expect(onReconnectStopped).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "loopback proxy policy rejected" }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("GatewayClient socket factory recovery", () => {
  it("retries transient node-host setup failures without requiring another start", async () => {
    const beforeConnect = vi.fn(() => {
      throw new Error("temporary node transport setup failure");
    });
    const { client, onConnectError } = createNodeClient({
      hostDeps: { beforeConnect },
    });

    client.start();
    expect(beforeConnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(beforeConnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(onConnectError).toHaveBeenCalledTimes(2);

    client.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(beforeConnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["ws://gateway.example:18789", undefined, "SECURITY ERROR"],
    ["not a gateway URL", undefined, "SECURITY ERROR"],
    ["ws://127.0.0.1:18789", "deadbeef", "gateway tls fingerprint requires wss:// gateway url"],
    [
      "wss://gateway.example:18789",
      "deadbeef",
      "gateway tls fingerprint must be a SHA-256 fingerprint",
    ],
  ] as const)("does not retry invalid target %s", async (url, tlsFingerprint, expectedMessage) => {
    const beforeConnect = vi.fn();
    const { client, onConnectError } = createNodeClient({
      url,
      tlsFingerprint,
      hostDeps: { beforeConnect },
    });

    client.start();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining(expectedMessage) }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onConnectError).toHaveBeenCalledOnce();
    expect(beforeConnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a loopback proxy bypass when WebSocket construction rejects the URL", () => {
    const unregister = vi.fn();
    const registerGatewayLoopbackBypass = vi.fn(() => unregister);
    const { client, onConnectError } = createNodeClient({
      url: "ws://127.0.0.1:18789/#invalid-fragment",
      hostDeps: { registerGatewayLoopbackBypass },
    });

    client.start();

    expect(registerGatewayLoopbackBypass).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "The URL contains a fragment identifier" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a loopback proxy policy failure terminal and observable", () => {
    const registerGatewayLoopbackBypass = vi.fn(() => {
      throw new Error("loopback proxy policy rejected");
    });
    const { client, onConnectError } = createNodeClient({
      hostDeps: { registerGatewayLoopbackBypass },
    });

    expect(() => client.start()).toThrow("loopback proxy policy rejected");
    expect(registerGatewayLoopbackBypass).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("GatewayProtocolClient lifecycle and event delivery", () => {
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
      const { client, connection } = startProtocolHarness({ onEvent });
      client.addEventListener(firstListener);
      client.addEventListener(staleListener);
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
    const { client, connection } = startProtocolHarness({ onEvent });
    removeListener = client.addEventListener(listener);

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
      const onEvent = vi.fn();
      const listener = vi.fn();
      const onGap = vi.fn(() => {
        if (recovery !== "reconnect") {
          client.stop();
          client.start();
        }
      });
      const { client, connections, connection: first } = startProtocolHarness({ onEvent, onGap });
      client.addEventListener(listener);
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
    const { client, connection } = startProtocolHarness({
      onEvent: () => calls.push("event"),
      onGap: () => {
        calls.push("gap");
        client.stop();
      },
    });
    client.addEventListener(() => calls.push("listener"));
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
