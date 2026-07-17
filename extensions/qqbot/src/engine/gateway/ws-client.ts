// Qqbot plugin module implements ws client behavior.
import type { Agent } from "node:http";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import WebSocket from "ws";

// `ws` otherwise waits indefinitely for an HTTP upgrade. Keep the 30s channel
// precedent (Discord, Slack, Signal) so a half-open upgrade eventually closes,
// releases GatewayConnection.isConnecting, and allows reconnects.
const QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;

// Reject inbound frames above 1 MB so a single overgrown gateway event cannot
// pin memory. Every other channel ws client sets a maxPayload (Discord: 16 MB,
// Slack, Signal, Mattermost: 1 MB).
const QQBOT_WEBSOCKET_MAX_PAYLOAD_BYTES = 1024 * 1024;

interface QQWSClientOptions {
  gatewayUrl: string;
  userAgent: string;
}

export async function createQQWSClient(options: QQWSClientOptions): Promise<WebSocket> {
  const wsAgent = await resolveAmbientNodeProxyAgent<Agent>();
  return new WebSocket(options.gatewayUrl, {
    headers: { "User-Agent": options.userAgent },
    handshakeTimeout: QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    maxPayload: QQBOT_WEBSOCKET_MAX_PAYLOAD_BYTES,
    ...(wsAgent ? { agent: wsAgent } : {}),
  });
}
