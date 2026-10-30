import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import type { GatewayProtocolSocket, GatewayProtocolSocketHandlers } from "./protocol-client.js";
import {
  createProtocolClient,
  createProtocolHarness,
  lastFrame,
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
    onReconnectScheduled: vi.fn<(delayMs: number, signal: AbortSignal) => void>(),
  };
  const harness = startProtocolHarness({ buildConnectPlan, ...spies }, { delayClose });
  return { ...harness, first: harness.connection, ...spies };
}
function receiveHello(connection: Connection): void {
  const frame = connection.frames[0];
  assert(frame);
  respond(connection, frame.id, { type: "hello-ok" });
}
const errorMessage = (message: unknown) => expect.objectContaining({ message });
async function expectCountAfter(ms: number, items: readonly unknown[], count: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(items).toHaveLength(count);
}
it("keeps admitted retry timing while advancing backoff", async () => {
  vi.mocked(Math.random).mockReturnValue(0.5);
  const { connections, onReconnectScheduled, first } = createHandshakeClient();
  receiveConnectChallenge(first);
  respond(
    first,
    lastFrame(first).id,
    {
      code: "UNAVAILABLE",
      message: "temporarily unavailable",
      retryable: true,
      retryAfterMs: 90_000,
    },
    false,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(onReconnectScheduled).toHaveBeenCalledExactlyOnceWith(99_000, expect.any(AbortSignal));
  const signal = onReconnectScheduled.mock.calls[0]?.[1];
  assert(signal);
  expect(signal.aborted).toBe(false);
  await expectCountAfter(98_999, connections, 1);
  await expectCountAfter(1, connections, 2);
  const second = connections[1];
  assert(second);
  second.close(1006, "transport unavailable");
  expect(signal.aborted).toBe(true);
  expect(onReconnectScheduled).toHaveBeenLastCalledWith(22, expect.any(AbortSignal));
  await expectCountAfter(21, connections, 2);
  await expectCountAfter(1, connections, 3);
});
it.each([false, true])(
  "cancels a scheduled retry when its observer stops the client (restart=%s)",
  async (restart) => {
    const { client, connections, onReconnectScheduled, first } = createHandshakeClient();
    onReconnectScheduled.mockImplementation(() => {
      client.stop();
      if (restart) {
        client.start();
      }
    });
    first.close(1006, "transport unavailable");
    expect(onReconnectScheduled).toHaveBeenCalledOnce();
    expect(onReconnectScheduled.mock.calls[0]?.[1].aborted).toBe(true);
    await expectCountAfter(100, connections, restart ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it.each(["before response", "before publication"])(
  "rejects hello when the connect deadline closes the transport %s",
  async (closingOrder) => {
    const { client, connections, onHello, onConnectHello, first } = createHandshakeClient(
      undefined,
      true,
    );
    first.close(1012, "restart");
    first.handlers.close(1012, "restart");
    await vi.advanceTimersByTimeAsync(10);
    const connection = connections[1];
    assert(connection);
    receiveConnectChallenge(connection);
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
    const onSent = vi.fn();
    await expect(client.request("status", undefined, { onSent })).rejects.toThrow(
      "gateway not connected",
    );
    expect(onSent).not.toHaveBeenCalled();
    connection.handlers.close(4000, "connect timeout");
    // An unusable hello must not reset the second retry's exponential delay.
    await expectCountAfter(10, connections, 2);
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
    await expectCountAfter(10, connections, 4);
  },
);
it.each([false, true])("suppresses a resolved hello after stop (restart=%s)", async (restart) => {
  const { client, connections, onHello, onConnectHello, first } = createHandshakeClient();
  receiveConnectChallenge(first);
  receiveHello(first);
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
  receiveConnectChallenge(first, {
    nonce: "first",
    ts: 1,
    capabilities: ["model-catalog-snapshot"],
  });
  expect(buildConnectPlan).toHaveBeenLastCalledWith(
    expect.objectContaining({
      nonce: "first",
      challengeTs: 1,
      serverCapabilities: ["model-catalog-snapshot"],
    }),
  );
  first.handlers.close(1006, "reconnect");
  await vi.advanceTimersByTimeAsync(10);
  const second = connections[1];
  assert.ok(second);
  receiveConnectChallenge(second);
  expect(buildConnectPlan).toHaveBeenLastCalledWith(
    expect.objectContaining({
      nonce: "synthetic-nonce",
      challengeTs: 1_800_000_000_000,
      serverCapabilities: [],
    }),
  );
});
it.each([{ nonce: "legacy-nonce" }, { nonce: "malformed-nonce", ts: "not-a-number" }])(
  "marks an invalid challenge timestamp as null: %j",
  (payload) => {
    const buildConnectPlan = vi.fn(() => ({}));
    const { first } = createHandshakeClient(buildConnectPlan);
    receiveConnectChallenge(first, payload);
    expect(buildConnectPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nonce: payload.nonce,
        challengeTs: null,
        serverCapabilities: [],
      }),
    );
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
it("spreads exponential retries through the cap and reset", async () => {
  const delays = [11, 22, 44, 88, 92, 92];
  vi.mocked(Math.random).mockReturnValue(0.5);
  const { client, createSocket, onConnectError } = createSocketFactoryHarness({
    initialFailures: delays.length,
    shouldRetrySocketFactoryError: () => true,
  });
  client.start();
  client.start();
  expect(createSocket).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  for (const [index, delay] of delays.entries()) {
    await expectCountAfter(delay - 1, createSocket.mock.calls, index + 1);
    await expectCountAfter(1, createSocket.mock.calls, index + 2);
  }
  expect(onConnectError).toHaveBeenCalledTimes(delays.length);
  expect(client.connected).toBe(true);
  client.resetReconnectBackoff(25);
  createSocket.mock.calls.at(-1)?.[0].close(1012, "service restart");
  await expectCountAfter(27, createSocket.mock.calls, delays.length + 1);
  await expectCountAfter(1, createSocket.mock.calls, delays.length + 2);
});
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
    await expectCountAfter(100, createSocket.mock.calls, restart ? 2 : 1);
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
  receiveConnectChallenge(first, { nonce: "challenge" });
  receiveHello(first);
  await vi.advanceTimersByTimeAsync(0);
  const pending = client
    .request("before-close", {}, { timeoutMs: null })
    .catch((error: unknown) => error);
  client.closeSocket(1012, "service restart");
  expect(await pending).toEqual(new Error("gateway closed (1012): service restart"));
  expect(connections).toHaveLength(2);
  expect(client.connected).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(onReconnectScheduled).not.toHaveBeenCalled();
  await expectCountAfter(100, connections, 2);
  const replacement = connections[1];
  assert(replacement);
  receiveConnectChallenge(replacement);
  receiveHello(replacement);
  await vi.advanceTimersByTimeAsync(0);
  respond(replacement, lastFrame(replacement).id, { healthy: true });
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
    await expectCountAfter(10, createSocket.mock.calls, 2);
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      errorMessage("loopback proxy policy rejected"),
    );
    if (rethrow) {
      expect(onCallbackError).toHaveBeenCalledExactlyOnceWith(
        "reconnect",
        errorMessage("loopback proxy policy rejected"),
      );
    } else {
      expect(onCallbackError).not.toHaveBeenCalled();
    }
    expect(onReconnectStopped).toHaveBeenCalledExactlyOnceWith(
      errorMessage("loopback proxy policy rejected"),
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);
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
    errorMessage(expect.stringContaining(expectedMessage)),
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
  expect(unregister).toHaveBeenCalledOnce();
  expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
    errorMessage("The URL contains a fragment identifier"),
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
  expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
    errorMessage("loopback proxy policy rejected"),
  );
  expect(vi.getTimerCount()).toBe(0);
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
test.each(["replace", "reconnect"])("drops gapped frames during %s recovery", async (recovery) => {
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
});
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
