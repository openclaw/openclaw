import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createProtocolHarness,
  receive,
  stopProtocolClients,
} from "./protocol-client.test-support.js";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "./timeouts.js";

type HandshakeConnection = ReturnType<typeof createProtocolHarness>["connections"][number];

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
  const { client, connections } = createProtocolHarness(
    { buildConnectPlan, ...spies },
    { delayClose },
  );
  client.start();
  const first = connections[0];
  assert(first);
  return { client, connections, first, ...spies };
}

function receiveConnectChallenge(connection: HandshakeConnection, ts = 1_800_000_000_000): void {
  connection.handlers.open();
  receive(connection, {
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "synthetic-nonce", ts },
  });
}

function receiveHello(connection: HandshakeConnection): void {
  const sent = connection.send.mock.calls[0];
  assert(sent);
  const request = JSON.parse(sent[0]) as { id: string };
  receive(connection, { type: "res", id: request.id, ok: true, payload: { type: "hello-ok" } });
}

describe("GatewayProtocolClient connect handshake", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    stopProtocolClients();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([{ retryable: true, retryAfterMs: 90_000, delayMs: 99_000, draw: 0.5, nextDelayMs: 22 }])(
    "keeps admitted retry timing while advancing backoff: %j",
    async ({ retryable, retryAfterMs, delayMs, draw, nextDelayMs }) => {
      vi.useFakeTimers();
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
      vi.useFakeTimers();
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
      vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
