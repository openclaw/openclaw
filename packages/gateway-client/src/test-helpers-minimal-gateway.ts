// Minimal gateway helpers for client-side proof tests.
// These mirror src/gateway/minimal-gateway.test-helpers.ts but are kept
// self-contained so the client package does not depend on gateway internals.
import type WebSocket from "ws";

/** Parses a raw WebSocket frame into the small request shape used by tests. */
export function parseMinimalGatewayRequestFrame(data: WebSocket.RawData): {
  type?: string;
  id?: string;
  method?: string;
} {
  return JSON.parse(rawDataToString(data)) as { type?: string; id?: string; method?: string };
}

/** Sends the connect challenge event expected by GatewayClient. */
export function sendMinimalGatewayConnectChallenge(ws: WebSocket, nonce = "test-nonce"): void {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce },
    }),
  );
}

const PROTOCOL_VERSION = 15;

/** Builds a minimal hello-ok payload for fake gateway servers. */
export function buildMinimalGatewayHelloOkPayload(params?: {
  connId?: string;
  methods?: string[];
}): Record<string, unknown> {
  return {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: { version: "proof", connId: params?.connId ?? "conn-proof" },
    features: {
      methods: params?.methods ?? ["proof.echo"],
      events: ["connect.challenge"],
    },
    snapshot: {},
    auth: { role: "operator", scopes: ["operator.approvals"] },
    policy: {
      maxPayload: 1_000_000,
      maxBufferedBytes: 1_000_000,
      tickIntervalMs: 60_000,
    },
  };
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((e) => Buffer.from(e))).toString("utf8");
  return String(data);
}
