import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayRequestOptions = { expectFinal?: boolean; timeoutMs?: number };

const gatewayRpcMock = vi.hoisted(() => {
  const hello = { protocol: 3, server: { version: "fixture-version" } };
  const request = vi.fn(
    async (_method: string, _params: unknown, _options: GatewayRequestOptions) => ({ ok: true }),
  );
  const stopAndWait = vi.fn(async () => {});
  const clients: Array<{ options: Record<string, unknown> }> = [];
  class GatewayClient {
    request = request;
    stopAndWait = stopAndWait;
    constructor(public options: Record<string, unknown>) {
      clients.push(this);
    }
  }
  const connectImmediately = async (client: GatewayClient) => {
    (client.options.onHelloOk as (hello: unknown) => void)(hello);
    return { ready: true, aborted: false };
  };
  const startGatewayClientWhenEventLoopReady = vi.fn(connectImmediately);
  return {
    GatewayClient,
    hello,
    clients,
    request,
    startGatewayClientWhenEventLoopReady,
    stopAndWait,
    reset() {
      clients.length = 0;
      request.mockReset().mockResolvedValue({ ok: true });
      stopAndWait.mockReset().mockResolvedValue(undefined);
      startGatewayClientWhenEventLoopReady.mockReset().mockImplementation(connectImmediately);
    },
  };
});

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: gatewayRpcMock.GatewayClient,
  startGatewayClientWhenEventLoopReady: gatewayRpcMock.startGatewayClientWhenEventLoopReady,
}));

import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

function startClient(options: Partial<Parameters<typeof startQaGatewayRpcClient>[0]> = {}) {
  return startQaGatewayRpcClient({
    wsUrl: "ws://127.0.0.1:18789",
    token: "qa-token",
    logs: () => "qa logs",
    ...options,
  });
}

function gatewayClientCallback(name: "onClose" | "onHelloOk" | "onReconnectPaused") {
  const callback = gatewayRpcMock.clients[0]?.options[name];
  if (typeof callback !== "function") {
    throw new Error(`expected Gateway client ${name} callback`);
  }
  return (info: unknown = gatewayRpcMock.hello) => callback(info);
}

describe("startQaGatewayRpcClient", () => {
  beforeEach(() => gatewayRpcMock.reset());
  afterEach(() => vi.useRealTimers());

  it("retains only observed hello identity and clears it across disconnect and stop", async () => {
    const deviceIdentity = {
      deviceId: "qa-observer-device",
      publicKeyPem: "fixture-public-key",
      privateKeyPem: "fixture-private-key",
    };
    const client = await startClient({ deviceIdentity, scopes: [], logs: () => "" });
    expect(gatewayRpcMock.clients[0]?.options).toMatchObject({
      deviceIdentity,
      scopes: [],
      sharedStateMode: "read-only",
    });
    expect(client.evidenceIdentity).toEqual({ protocol: 3, version: "fixture-version" });
    const identity = client.evidenceIdentity!;
    identity.version = "caller-mutation";
    expect(client.evidenceIdentity?.version).toBe("fixture-version");
    gatewayClientCallback("onClose")();
    expect(client.evidenceIdentity).toBeNull();
    gatewayClientCallback("onHelloOk")({
      protocol: 4,
      server: { version: "replacement" },
      auth: { token: "never-retain" },
    });
    expect(client.evidenceIdentity).toEqual({ protocol: 4, version: "replacement" });
    await client.stop();
    expect(client.evidenceIdentity).toBeNull();
  });

  it("dispatches concurrent requests over the same client", async () => {
    const held = Promise.withResolvers<{ ok: boolean }>();
    gatewayRpcMock.request
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce({ ok: true });
    const client = await startClient();
    const firstRequest = client.request("health");
    await Promise.resolve();
    const secondRequest = client.request("status");
    await expect(secondRequest).resolves.toEqual({ ok: true });
    held.resolve({ ok: true });
    await expect(firstRequest).resolves.toEqual({ ok: true });
  });

  it("waits for reconnect before dispatching a request", async () => {
    const client = await startClient();
    gatewayClientCallback("onClose")();

    const request = client.request("status", {}, { timeoutMs: 5_000 });
    await Promise.resolve();
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();

    gatewayClientCallback("onHelloOk")();
    await expect(request).resolves.toEqual({ ok: true });
  });

  it.each([
    ["startup", "gateway request deadline exceeded"],
    ["deadline", "gateway request deadline exceeded"],
    ["terminal", "gateway reconnect paused (1008): authentication failed [AUTH_FAILED]"],
    ["stop", "gateway rpc client stopped"],
  ] as const)("rejects %s without dispatching a request", async (phase, error) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    if (phase === "startup") {
      gatewayRpcMock.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
        ready: true,
        aborted: false,
      });
    }
    const starting = startClient();
    const client = phase === "startup" ? undefined : await starting;
    if (phase === "terminal") {
      gatewayClientCallback("onReconnectPaused")({
        code: 1008,
        detailCode: "AUTH_FAILED",
        reason: "authentication failed",
      });
      expect(client?.evidenceIdentity).toBeNull();
    }
    if (client) {
      gatewayClientCallback("onClose")();
    }
    const pending = client
      ? client.request("status", {}, { deadlineMs: 1_250, timeoutMs: 5_000 })
      : starting;
    const rejected = expect(pending).rejects.toThrow(`${error}\nGateway logs:\nqa logs`);
    if (phase === "stop") {
      await client?.stop();
    } else if (phase === "startup" || phase === "deadline") {
      await vi.advanceTimersByTimeAsync(phase === "startup" ? 20_000 : 250);
    }
    await rejected;
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();
    if (phase === "startup") {
      expect(gatewayRpcMock.stopAndWait).toHaveBeenCalledOnce();
    }
  });

  it.each([new Error("gateway not connected"), "gateway rejected request"])(
    "does not replay %s and redacts logs when wrapping the failure",
    async (error) => {
      gatewayRpcMock.request.mockRejectedValueOnce(error);
      const client = await startClient({ logs: () => "OPENCLAW_GATEWAY_TOKEN=secret-token" });
      const message = error instanceof Error ? error.message : error;
      await expect(client.request("agent.run")).rejects.toMatchObject({
        cause: expect.objectContaining({ message }),
        message: `${message}\nGateway logs:\nOPENCLAW_GATEWAY_TOKEN=<redacted>`,
      });
      expect(gatewayRpcMock.request).toHaveBeenCalledOnce();
    },
  );
});
