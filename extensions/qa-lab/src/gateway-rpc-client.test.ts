import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => {
  const hello = { protocol: 3, server: { version: "fixture-version" } };
  const request = vi.fn(async () => ({ ok: true }));
  const stop = vi.fn(async () => {});
  const Client = vi.fn(
    class {
      request = request;
      stopAndWait = stop;
      constructor(public options: Record<string, unknown>) {}
    },
  );
  const start = vi.fn(async (client: InstanceType<typeof Client>) => {
    (client.options.onHelloOk as (hello: unknown) => void)(hello);
    return { ready: true, aborted: false };
  });
  return { Client, hello, request, start, stop };
});

// mock-isolation: Exercise reconnect ownership with a deterministic client instead of live sockets.
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: rpc.Client,
  startGatewayClientWhenEventLoopReady: rpc.start,
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

function emit(name: "onClose" | "onHelloOk" | "onReconnectPaused", info: unknown = rpc.hello) {
  const callback = rpc.Client.mock.calls[0]?.[0][name];
  if (typeof callback !== "function") {
    throw new Error(`expected Gateway client ${name} callback`);
  }
  callback(info);
}

beforeEach(() => [rpc.Client, rpc.request, rpc.start, rpc.stop].forEach((m) => m.mockReset()));
afterEach(() => vi.useRealTimers());

it("retains only observed hello identity and clears it across disconnect and stop", async () => {
  const deviceIdentity = { deviceId: "device", publicKeyPem: "public", privateKeyPem: "private" };
  const client = await startClient({ deviceIdentity, scopes: [], logs: () => "" });
  expect(rpc.Client.mock.calls[0]?.[0]).toMatchObject({
    deviceIdentity,
    scopes: [],
    sharedStateMode: "read-only",
  });
  expect(client.evidenceIdentity).toEqual({ protocol: 3, version: "fixture-version" });
  client.evidenceIdentity!.version = "caller-mutation";
  expect(client.evidenceIdentity?.version).toBe("fixture-version");
  emit("onClose");
  expect(client.evidenceIdentity).toBeNull();
  emit("onHelloOk", { protocol: 4, server: { version: "new" }, auth: { token: "secret" } });
  expect(client.evidenceIdentity).toEqual({ protocol: 4, version: "new" });
  await client.stop();
  expect(client.evidenceIdentity).toBeNull();
});

it("gates concurrent requests on reconnect without serializing their dispatch", async () => {
  const held = Promise.withResolvers<{ ok: boolean }>();
  rpc.request.mockImplementationOnce(() => held.promise).mockResolvedValueOnce({ ok: true });
  const client = await startClient();
  emit("onClose");
  const firstRequest = client.request("health");
  const secondRequest = client.request("status");
  await Promise.resolve();
  expect(rpc.request).not.toHaveBeenCalled();
  emit("onHelloOk");
  await expect(secondRequest).resolves.toEqual({ ok: true });
  held.resolve({ ok: true });
  await expect(firstRequest).resolves.toEqual({ ok: true });
});

it.each([
  ["startup", "gateway request deadline exceeded"],
  ["deadline", "gateway request deadline exceeded"],
  ["terminal", "gateway reconnect paused (1008): denied [AUTH_FAILED]"],
  ["stop", "gateway rpc client stopped"],
] as const)("rejects %s without dispatching a request", async (phase, error) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  if (phase === "startup") {
    rpc.start.mockResolvedValueOnce({
      ready: true,
      aborted: false,
    });
  }
  const starting = startClient();
  const client = phase === "startup" ? undefined : await starting;
  if (phase === "terminal") {
    emit("onReconnectPaused", { code: 1008, detailCode: "AUTH_FAILED", reason: "denied" });
    expect(client?.evidenceIdentity).toBeNull();
  }
  if (client) {
    emit("onClose");
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
  expect(rpc.request).not.toHaveBeenCalled();
  if (phase === "startup") {
    expect(rpc.stop).toHaveBeenCalledOnce();
  }
});

it.each([new Error("gateway not connected"), "gateway rejected request"])(
  "does not replay %s and redacts logs when wrapping the failure",
  async (error) => {
    rpc.request.mockRejectedValueOnce(error);
    const client = await startClient({ logs: () => "OPENCLAW_GATEWAY_TOKEN=secret-token" });
    const message = error instanceof Error ? error.message : error;
    await expect(client.request("agent.run")).rejects.toMatchObject({
      cause: expect.objectContaining({ message }),
      message: `${message}\nGateway logs:\nOPENCLAW_GATEWAY_TOKEN=<redacted>`,
    });
    expect(rpc.request).toHaveBeenCalledOnce();
  },
);
