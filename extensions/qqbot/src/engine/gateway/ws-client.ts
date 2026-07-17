// Qqbot plugin module implements ws client behavior.
import type { Agent } from "node:http";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import WebSocket from "ws";

// `ws` otherwise waits indefinitely for an HTTP upgrade. Keep the 30s channel
// precedent (Discord, Slack, Signal) so a half-open upgrade eventually closes,
// releases GatewayConnection.isConnecting, and allows reconnects.
const QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;

// QQ Bot gateway frames are JSON envelopes only — media travels via HTTP
// upload APIs, not the gateway WebSocket. The largest legitimate frame is a
// message dispatch event whose text content is capped by TEXT_CHUNK_LIMIT
// (5000 chars × 4 bytes/char worst-case UTF-8 = 20 KB). Adding embeds,
// message_reference, author, member, and JSON envelope overhead, the
// maximum valid frame stays under ~100 KB. 1 MiB provides >10× headroom
// while failing closed well before the ws library default of 100 MiB can
// pin memory.
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
