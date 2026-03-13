/**
 * OpenClaw gateway client for Next.js server-side use.
 *
 * Uses Node.js 22 native WebSocket for one-shot RPC calls and
 * plain fetch for HTTP endpoints (health, chat completions).
 *
 * Configure via env vars:
 *   GATEWAY_URL   – base URL of the gateway   (default: http://localhost:18789)
 *   GATEWAY_TOKEN – Bearer token for gateway auth (omit if auth.mode=none)
 */
import { randomUUID } from "crypto";

export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:18789";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

// ── Types ─────────────────────────────────────────────────────────────────────

interface RpcFrame {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface GatewayAgent {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  model?: string;
  createdAt?: string;
}

export interface GatewaySession {
  id: string;
  title?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

export interface GatewayStatus {
  online: boolean;
  version?: string;
  uptime?: number;
  agentCount?: number;
  sessionCount?: number;
}

// ── WebSocket RPC ─────────────────────────────────────────────────────────────

/**
 * Make a single authenticated WebSocket RPC call to the gateway.
 * Opens a connection, authenticates, sends the method, returns the result,
 * and closes the connection.
 */
export async function gatewayRpc<T = unknown>(
  method: string,
  params?: unknown,
  timeoutMs = 12_000
): Promise<T> {
  const wsUrl = GATEWAY_URL.replace(/^http/, "ws");

  return new Promise<T>((resolve, reject) => {
    // Node.js 22+ has global WebSocket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ws: any;
    try {
      // @ts-expect-error – Node 22 global WebSocket
      ws = new WebSocket(wsUrl);
    } catch {
      reject(new Error("Cannot connect to gateway (WebSocket unavailable)"));
      return;
    }

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`Gateway RPC timeout: ${method}`));
    }, timeoutMs);

    const connectId = randomUUID();
    const methodId = randomUUID();
    let authenticated = false;
    let settled = false;

    function done(err: Error | null, result?: T) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(result as T);
    }

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: connectId,
          method: "connect",
          params: {
            ...(GATEWAY_TOKEN ? { token: GATEWAY_TOKEN } : {}),
            role: "operator",
          },
        })
      );
    };

    ws.onmessage = (event: { data: string }) => {
      let frame: RpcFrame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!authenticated) {
        if (frame.id !== connectId) return; // ignore events before auth
        if (!frame.ok) {
          done(new Error(`Gateway auth denied: ${frame.error?.message ?? "unknown"}`));
          return;
        }
        authenticated = true;
        ws.send(JSON.stringify({ id: methodId, method, params }));
        return;
      }

      if (frame.id === methodId) {
        if (frame.ok) {
          done(null, frame.result as T);
        } else {
          done(new Error(frame.error?.message ?? `Gateway RPC error: ${method}`));
        }
      }
    };

    ws.onerror = () => done(new Error("Gateway WebSocket connection error"));

    ws.onclose = () => {
      if (!settled) {
        done(new Error("Gateway connection closed unexpectedly"));
      }
    };
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function gatewayHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    ...extra,
  };
}

/** Fetch gateway health via HTTP (fast, no WebSocket needed). */
export async function gatewayHealth(): Promise<{ online: boolean; status?: string }> {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      headers: gatewayHeaders(),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!res.ok) return { online: false };
    const body = await res.json();
    return { online: true, status: body.status ?? "live" };
  } catch {
    return { online: false };
  }
}

/**
 * Proxy a chat completions request to the gateway and return its raw Response
 * (supports streaming). Callers should pass this directly to Next.js Response.
 */
export async function gatewayChatProxy(
  body: unknown
): Promise<Response> {
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(),
    body: JSON.stringify(body),
    // @ts-expect-error – Node.js fetch needs duplex for streaming
    duplex: "half",
  });
  return res;
}
