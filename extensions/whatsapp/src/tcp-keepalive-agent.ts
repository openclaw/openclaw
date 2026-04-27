import type { Agent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

/**
 * Default TCP keepalive initial delay in milliseconds.
 *
 * Windows Hyper-V NAT drops idle TCP connections after ~60 seconds.
 * Baileys sends application-level WebSocket pings every 25-30 seconds,
 * but NAT devices operate at the TCP layer and don't inspect WS frames.
 * A 15-second initial delay sends TCP ACK probes well before the NAT
 * timeout, keeping the connection alive on WSL2 and similar environments.
 *
 * This value is harmless on stable networks — it adds only a few small
 * TCP ACK packets per interval to otherwise-idle connections.
 */
const DEFAULT_INITIAL_DELAY_MS = 15_000;

/**
 * Wraps an HTTP/HTTPS agent to enable TCP keepalive on every underlying socket.
 *
 * When a proxy agent is provided, the wrapper delegates socket creation to it
 * and applies keepalive to the resulting tunnel socket. Without a proxy, it
 * delegates to the default agent behavior. In both cases, keepalive is set
 * on the raw TCP socket before the TLS handshake completes, which is the
 * correct time to do it.
 *
 * This covers both initial connections and reconnects because `createConnection`
 * is called for every new socket.
 *
 * Returns `undefined` when `baseAgent` is `undefined` — callers can use this
 * to avoid passing an agent wrapper when no proxy is configured.
 */
export function wrapAgentWithTcpKeepalive(
  baseAgent: Agent | HttpsAgent | undefined,
  opts: { initialDelayMs?: number } = {},
): Agent | HttpsAgent | undefined {
  if (!baseAgent) {
    return undefined;
  }

  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const originalCreateConnection = baseAgent.createConnection.bind(baseAgent);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (baseAgent as any).createConnection = function (...args: Parameters<Agent["createConnection"]>) {
    const [options, callback] = args;
    return originalCreateConnection(options, (err: Error | null, socket: Socket | undefined) => {
      if (!err && socket) {
        applyTcpKeepAlive(socket as Socket | TLSSocket, initialDelayMs);
      }
      callback(err, socket);
    });
  };

  return baseAgent;
}

function applyTcpKeepAlive(socket: Socket | TLSSocket, initialDelayMs: number): void {
  try {
    socket.setKeepAlive(true, initialDelayMs);
  } catch {
    // Best-effort: keepalive is defense-in-depth. If it fails,
    // Baileys' WS pings and the connection watchdog still provide
    // fallback recovery. Do not let this crash the connection.
  }
}
