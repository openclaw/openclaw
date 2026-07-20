// Qqbot plugin module implements ws client behavior.
import type { Agent } from "node:http";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import WebSocket from "ws";

// `ws` otherwise waits indefinitely for an HTTP upgrade. Keep the 30s channel
// precedent (Discord, Slack, Signal) so a half-open upgrade eventually closes,
// releases GatewayConnection.isConnecting, and allows reconnects.
const QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;

// QQ Bot gateway frames are JSON envelopes only; media travels via HTTP upload
// APIs. QQ does not publish a smaller inbound-frame maximum, so keep the same
// conservative 16 MiB ceiling used by other JSON-heavy channel gateways. This
// preserves headroom for large valid events while bounding `ws` well below its
// 100 MiB default before JSON parsing begins.
const QQBOT_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

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
