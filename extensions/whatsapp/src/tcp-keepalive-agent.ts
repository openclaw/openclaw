import type { Agent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
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
 * Handles two creation patterns used by different agent implementations:
 * - **Callback pattern** (Node.js core `http.Agent`): socket delivered via
 *   the `(err, socket) => void` callback.
 * - **Synchronous return pattern** (`proxy-agent` via `agent-base`): socket
 *   returned directly from `createConnection()` without invoking the callback.
 *
 * Both paths apply keepalive, ensuring coverage regardless of which agent
 * implementation is active.
 *
 * Returns `undefined` when `baseAgent` is `undefined` — callers can use this
 * to avoid passing an agent wrapper when no proxy is configured.
 */
export function wrapAgentWithTcpKeepalive(
  baseAgent: Agent | undefined,
  opts: { initialDelayMs?: number } = {},
): Agent | undefined {
  if (!baseAgent) {
    return undefined;
  }

  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const originalCreateConnection = baseAgent.createConnection.bind(baseAgent);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const self = baseAgent as any;
  self.createConnection = function (...args: Parameters<Agent["createConnection"]>) {
    const [options, callback] = args;
    const result = originalCreateConnection(options, (err: Error | null, stream: Duplex) => {
      if (!err && stream) {
        applyTcpKeepAlive(stream as Socket | TLSSocket, initialDelayMs);
      }
      callback?.(err, stream);
    });

    // proxy-agent (via agent-base) returns the socket synchronously and may
    // not invoke the callback. Apply keepalive to the returned value too.
    if (result && typeof result !== "function") {
      applyTcpKeepAlive(result as Socket | TLSSocket, initialDelayMs);
    }

    return result;
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
