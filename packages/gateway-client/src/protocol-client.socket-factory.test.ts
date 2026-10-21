import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import type { GatewayProtocolSocket, GatewayProtocolSocketHandlers } from "./protocol-client.js";
import {
  createProtocolClient,
  createProtocolHarness,
  receive,
  stopProtocolClients,
} from "./protocol-client.test-support.js";

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
