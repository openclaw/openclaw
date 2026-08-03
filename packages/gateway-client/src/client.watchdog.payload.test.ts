// Gateway Client tests cover negotiated request-frame payload enforcement.
import type { HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GatewayClient } from "./client.js";
import type { GatewayProtocolSocket } from "./protocol-client.js";

type ProtocolHarness = {
  socket: GatewayProtocolSocket | null;
  stopped: boolean;
  generation: number;
  reconnectSupervisor: { reset(initialMs?: number): void };
  pending: Map<string, unknown>;
  handleMessage: (socket: GatewayProtocolSocket, generation: number, raw: string) => void;
};

function protocolHarness(client: GatewayClient): ProtocolHarness {
  return (client as unknown as { protocol: ProtocolHarness }).protocol;
}

function installSyntheticSocket(
  client: GatewayClient,
  send: (data: string) => unknown,
  close: (code?: number, reason?: string) => unknown,
): void {
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    send: (data) => send(data),
    close: (code, reason) => close(code, reason),
  };
  Object.assign(protocolHarness(client), { socket, stopped: false, generation: 1 });
  (client as unknown as { ws: unknown }).ws = {
    readyState: WebSocket.OPEN,
    send,
    close,
    terminate: vi.fn(),
  };
}

function createOpenGatewayClient(requestTimeoutMs: number): {
  client: GatewayClient;
  send: ReturnType<typeof vi.fn>;
} {
  const client = new GatewayClient({
    requestTimeoutMs,
  });
  const send = vi.fn();
  installSyntheticSocket(client, send, vi.fn());
  return { client, send };
}

function getPendingCount(client: GatewayClient): number {
  return protocolHarness(client).pending.size;
}

function handleGatewayMessage(client: GatewayClient, payload: Record<string, unknown>): void {
  const protocol = protocolHarness(client);
  if (!protocol.socket) {
    throw new Error("synthetic protocol socket missing");
  }
  protocol.handleMessage(protocol.socket, protocol.generation, JSON.stringify(payload));
}

describe("GatewayClient", () => {
  test("enforces the latest negotiated request payload before sending", async () => {
    const { client, send } = createOpenGatewayClient(25);
    const payloadHarness = client as unknown as {
      handleConnectHello: (hello: Pick<HelloOk, "auth" | "policy">, assembled: unknown) => void;
      maxPayloadBytes: number;
    };
    payloadHarness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 128, maxBufferedBytes: 256, tickIntervalMs: 30_000 },
      },
      {},
    );

    await expect(client.request("node.invoke", { jsonl: "x".repeat(128) })).rejects.toThrow(
      "gateway request node.invoke exceeds negotiated max payload",
    );
    expect(payloadHarness.maxPayloadBytes).toBe(128);
    expect(send).not.toHaveBeenCalled();
    expect(getPendingCount(client)).toBe(0);

    payloadHarness.handleConnectHello(
      {
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 512, maxBufferedBytes: 1_024, tickIntervalMs: 30_000 },
      },
      {},
    );
    const request = client.request<{ status: string }>("node.invoke", {
      jsonl: "x".repeat(128),
    });
    const frame = JSON.parse(String(send.mock.calls[0]?.[0])) as { id: string };
    handleGatewayMessage(client, {
      type: "res",
      id: frame.id,
      ok: true,
      payload: { status: "ok" },
    });

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(payloadHarness.maxPayloadBytes).toBe(512);
    expect(send).toHaveBeenCalledTimes(1);
    client.stop();
  });
});
