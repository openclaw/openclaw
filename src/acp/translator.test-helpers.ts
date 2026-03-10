import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";

export function createAcpConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn(async () => {}),
  } as unknown as AgentSideConnection;
}

export function createAcpGateway(
  request: GatewayClient["request"] = vi.fn(async () => ({ ok: true })) as GatewayClient["request"],
): GatewayClient {
  return {
    request,
  } as unknown as GatewayClient;
}
