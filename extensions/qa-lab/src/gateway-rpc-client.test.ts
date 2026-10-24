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
    const client = await startClient({ logs: () => "" });
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

  it("forwards ephemeral device identity and empty scopes without shared-state writes", async () => {
    const scopes: string[] = [];
    const deviceIdentity = {
      deviceId: "qa-observer-device",
      publicKeyPem: "fixture-public-key",
      privateKeyPem: "fixture-private-key",
    };
    const client = await startClient({ deviceIdentity, scopes });
    expect(gatewayRpcMock.clients[0]?.options).toMatchObject({
      deviceIdentity,
      scopes,
      sharedStateMode: "read-only",
    });
    await client.stop();
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
    await Promise.resolve();
    await vi.waitFor(() => expect(gatewayRpcMock.request).toHaveBeenCalledTimes(2));
    await expect(secondRequest).resolves.toEqual({ ok: true });
    held.resolve({ ok: true });
    await expect(firstRequest).resolves.toEqual({ ok: true });
  });

  it("bounds startup when readiness completes but the Gateway never sends hello", async () => {
    vi.useFakeTimers();
    gatewayRpcMock.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
    });

    const rejection = expect(startClient()).rejects.toThrow(
      "gateway request deadline exceeded\nGateway logs:\nqa logs",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(gatewayRpcMock.stopAndWait).toHaveBeenCalledOnce();
  });

  it("waits for reconnect before dispatching a request", async () => {
    const client = await startClient();
    gatewayClientCallback("onClose")();

    const request = client.request("status", {}, { timeoutMs: 5_000 });
    await Promise.resolve();
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();

    gatewayClientCallback("onHelloOk")();
    await expect(request).resolves.toEqual({ ok: true });
    expect(gatewayRpcMock.request).toHaveBeenCalledOnce();
  });

  it("applies the request deadline while waiting for reconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const client = await startClient();
    gatewayClientCallback("onClose")();

    const rejection = expect(
      client.request("status", {}, { deadlineMs: 1_250, timeoutMs: 5_000 }),
    ).rejects.toThrow("gateway request deadline exceeded");
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();
  });

  it("preserves a terminal reconnect failure through the following close", async () => {
    const client = await startClient();

    gatewayClientCallback("onReconnectPaused")({
      code: 1008,
      detailCode: "AUTH_FAILED",
      reason: "authentication failed",
    });
    expect(client.evidenceIdentity).toBeNull();
    gatewayClientCallback("onClose")();

    await expect(client.request("status")).rejects.toThrow(
      "gateway reconnect paused (1008): authentication failed [AUTH_FAILED]",
    );
    expect(gatewayRpcMock.request).not.toHaveBeenCalled();
  });

  it("does not replay a request whose Gateway error says it is not connected", async () => {
    gatewayRpcMock.request.mockRejectedValueOnce(new Error("gateway not connected"));
    const client = await startClient();

    await expect(client.request("agent.run")).rejects.toThrow("gateway not connected");
    expect(gatewayRpcMock.request).toHaveBeenCalledOnce();
  });

  it("wraps normalized request failures with redacted gateway logs", async () => {
    gatewayRpcMock.request.mockRejectedValueOnce("gateway rejected request");
    const client = await startClient({ logs: () => "OPENCLAW_GATEWAY_TOKEN=secret-token" });

    await expect(client.request("health")).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "gateway rejected request" }),
      message: "gateway rejected request\nGateway logs:\nOPENCLAW_GATEWAY_TOKEN=<redacted>",
    });
  });

  it("rejects a request waiting for reconnect when stopped", async () => {
    const client = await startClient();
    gatewayClientCallback("onClose")();
    const request = client.request("health");

    await client.stop();
    await expect(request).rejects.toThrow("gateway rpc client stopped\nGateway logs:\nqa logs");
  });
});
