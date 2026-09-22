import type { lookup as dnsLookupCb } from "node:dns";
import type { ClientRequest } from "node:http";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { getHeadersWithAuth, stripCdpUrlCredentials } from "./cdp-auth.js";
import { getDirectAgentForCdp, withManagedProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { getPlaywrightUserAgent } from "./playwright-core.runtime.js";
import { normalizeBrowserTimerDelayMs } from "./timer-delay.js";

const PLAYWRIGHT_CDP_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const PLAYWRIGHT_CDP_PER_MESSAGE_DEFLATE = {
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 3 },
  zlibInflateOptions: { chunkSize: 10 * 1024 },
  threshold: 10 * 1024,
} as const;
const PLAYWRIGHT_CDP_MAX_REDIRECTS = 10;
type CdpSocketLookup = typeof dnsLookupCb;

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export class CdpSocketError extends Error {
  constructor(
    readonly kind: "closed" | "timeout" | "protocol",
    message: string,
  ) {
    super(message);
  }
}

function withDefaultPlaywrightUserAgent(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).some((key) => key.trim().toLowerCase() === "user-agent")) {
    return headers;
  }
  return { ...headers, "User-Agent": getPlaywrightUserAgent() };
}

function cdpWebSocketAuthority(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function assertSameAuthorityWebSocketRedirect(
  originalUrl: string,
  redirectedUrl: string,
  request: ClientRequest,
): void {
  if (cdpWebSocketAuthority(originalUrl) === cdpWebSocketAuthority(redirectedUrl)) {
    return;
  }
  request.destroy(new Error("CDP WebSocket redirect changed authority"));
}

function defaultPortForWebSocketProtocol(protocol: string): string {
  return protocol === "wss:" || protocol === "https:" ? "443" : "80";
}

function normalizeAuthorityHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function hostnameFromAgentOptions(options: unknown): string | undefined {
  if (options instanceof URL) {
    return options.hostname;
  }
  if (!options || typeof options !== "object") {
    return undefined;
  }
  if ("hostname" in options && typeof options.hostname === "string") {
    return options.hostname;
  }
  const rawHost = "host" in options && typeof options.host === "string" ? options.host : undefined;
  if (!rawHost) {
    return undefined;
  }
  if (rawHost.startsWith("[")) {
    const end = rawHost.indexOf("]");
    return end > 0 ? rawHost.slice(1, end) : rawHost;
  }
  if ((rawHost.match(/:/g) ?? []).length > 1) {
    return rawHost;
  }
  return rawHost.includes(":") ? rawHost.split(":")[0] : rawHost;
}

function portFromAgentOptions(options: unknown, fallbackProtocol: string): string {
  if (options instanceof URL) {
    return options.port || defaultPortForWebSocketProtocol(options.protocol);
  }
  if (!options || typeof options !== "object") {
    return defaultPortForWebSocketProtocol(fallbackProtocol);
  }
  if ("port" in options) {
    const rawPort = options.port;
    if (typeof rawPort === "string" || typeof rawPort === "number") {
      return String(rawPort);
    }
  }
  return defaultPortForWebSocketProtocol(fallbackProtocol);
}

function assertPinnedAgentAuthority(originalUrl: string, options: unknown): void {
  const parsed = new URL(originalUrl);
  const expectedHostname = normalizeAuthorityHostname(parsed.hostname);
  const expectedPort = parsed.port || defaultPortForWebSocketProtocol(parsed.protocol);
  const requestedHostname = hostnameFromAgentOptions(options);
  const requestedPort = portFromAgentOptions(options, parsed.protocol);
  if (
    !requestedHostname ||
    normalizeAuthorityHostname(requestedHostname) !== expectedHostname ||
    requestedPort !== expectedPort
  ) {
    throw new Error("CDP WebSocket redirect changed authority");
  }
}

function createPinnedAgentForCdpUrl(
  url: string,
  lookup: CdpSocketLookup,
): http.Agent | https.Agent {
  const parsed = new URL(url);
  const options = { keepAlive: false, lookup };
  const agent =
    parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? new https.Agent(options)
      : new http.Agent(options);
  const createConnection = agent.createConnection.bind(agent);
  agent.createConnection = ((connectionOptions, callback) => {
    try {
      assertPinnedAgentAuthority(url, connectionOptions);
    } catch (err) {
      const socket = new net.Socket();
      const error = toStringifiedError(err);
      process.nextTick(() => {
        callback?.(error, socket);
        socket.destroy(error);
      });
      return socket;
    }
    return createConnection(connectionOptions, callback);
  }) as typeof agent.createConnection;
  return agent;
}

function createCdpSender(ws: WebSocket, opts?: CdpSocketOptions) {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const commandTimeoutMs =
    typeof opts?.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs)
      ? normalizeBrowserTimerDelayMs(opts.commandTimeoutMs)
      : undefined;

  const clearPendingTimer = (p: Pending) => {
    if (p.timer !== undefined) {
      clearTimeout(p.timer);
    }
  };

  const send: CdpSendFn = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const id = nextId++;
    const msg = { id, method, params, sessionId };
    return new Promise<unknown>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new CdpSocketError("closed", "CDP socket closed"));
        return;
      }
      const entry: Pending = { resolve, reject };
      if (commandTimeoutMs !== undefined) {
        // A timed-out command closes the whole socket so pending calls do not
        // hang on a connection whose CDP command stream is no longer reliable.
        entry.timer = setTimeout(() => {
          closeWithError(
            new CdpSocketError(
              "timeout",
              `CDP command ${method} timed out after ${commandTimeoutMs}ms`,
            ),
          );
        }, commandTimeoutMs);
      }
      pending.set(id, entry);
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        pending.delete(id);
        clearPendingTimer(entry);
        reject(toStringifiedError(err));
      }
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      clearPendingTimer(p);
      p.reject(err);
    }
    pending.clear();
    if (
      opts?.abortScope === "operation" &&
      err instanceof CdpSocketError &&
      err.kind === "timeout"
    ) {
      ws.terminate();
    } else {
      ws.close();
    }
  };

  ws.on("error", (err) => {
    // The `err instanceof Error` guard is defensive: Node's `ws` library
    // always emits Error instances on the 'error' event. Triggering the
    // non-Error branch would require synthetically emitting on the socket,
    // which the library treats as an unhandled error and hangs the test.
    /* c8 ignore next */
    closeWithError(toStringifiedError(err));
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(rawDataToString(data)) as CdpResponse;
      if (typeof parsed.id !== "number") {
        return;
      }
      const p = pending.get(parsed.id);
      if (!p) {
        return;
      }
      pending.delete(parsed.id);
      clearPendingTimer(p);
      if (parsed.error?.message) {
        p.reject(new CdpSocketError("protocol", parsed.error.message));
        return;
      }
      p.resolve(parsed.result);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    closeWithError(new CdpSocketError("closed", "CDP socket closed"));
  });

  return { send, closeWithError };
}

/** Open a CDP WebSocket with URL basic-auth and proxy bypass handling. */
export function openCdpWebSocket(
  wsUrl: string,
  opts?: {
    headers?: Record<string, string>;
    handshakeTimeoutMs?: number;
    lookup?: CdpSocketLookup;
    playwrightTransportDefaults?: boolean;
  },
): WebSocket {
  const headersWithAuth = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const headers = opts?.playwrightTransportDefaults
    ? withDefaultPlaywrightUserAgent(headersWithAuth)
    : headersWithAuth;
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : CDP_WS_HANDSHAKE_TIMEOUT_MS;
  const connectionUrl = stripCdpUrlCredentials(wsUrl);
  const agent = opts?.lookup
    ? createPinnedAgentForCdpUrl(connectionUrl, opts.lookup)
    : getDirectAgentForCdp(connectionUrl);
  return withManagedProxyForCdpUrl(connectionUrl, () => {
    const ws = new WebSocket(connectionUrl, {
      handshakeTimeout: handshakeTimeoutMs,
      ...(opts?.playwrightTransportDefaults
        ? {
            followRedirects: true,
            maxRedirects: PLAYWRIGHT_CDP_MAX_REDIRECTS,
            maxPayload: PLAYWRIGHT_CDP_MAX_PAYLOAD_BYTES,
            perMessageDeflate: PLAYWRIGHT_CDP_PER_MESSAGE_DEFLATE,
          }
        : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(agent ? { agent } : {}),
    });
    if (opts?.playwrightTransportDefaults) {
      ws.on("redirect", (redirectedUrl, request) => {
        assertSameAuthorityWebSocketRedirect(connectionUrl, redirectedUrl, request);
      });
    }
    return ws;
  });
}

type CdpSocketOptions = {
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  handshakeRetries?: number;
  handshakeRetryDelayMs?: number;
  handshakeMaxRetryDelayMs?: number;
  lookup?: CdpSocketLookup;
  signal?: AbortSignal;
  /** Read-only probes can cancel commands; write callers retain the socket for compensation. */
  abortScope?: "operation";
};

function normalizeRetryCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function computeHandshakeRetryDelayMs(attempt: number, opts?: CdpSocketOptions): number {
  const baseDelayMs =
    typeof opts?.handshakeRetryDelayMs === "number" && Number.isFinite(opts.handshakeRetryDelayMs)
      ? Math.max(1, Math.floor(opts.handshakeRetryDelayMs))
      : 200;
  const maxDelayMs =
    typeof opts?.handshakeMaxRetryDelayMs === "number" &&
    Number.isFinite(opts.handshakeMaxRetryDelayMs)
      ? Math.max(baseDelayMs, Math.floor(opts.handshakeMaxRetryDelayMs))
      : 3000;
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  // Jitter keeps several browser sessions from retrying handshakes in lockstep
  // after a shared Chrome or network hiccup.
  const jitterScale = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.floor(raw * jitterScale));
}

function shouldRetryCdpHandshakeError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  if (!msg) {
    return false;
  }
  if (msg.includes("rate limit")) {
    return false;
  }
  const statusMatch = msg.match(/(?:unexpected server response|response):\s*(\d{3})/);
  if (statusMatch?.[1]) {
    return Number(statusMatch[1]) >= 500;
  }
  return (
    msg.includes("cdp socket closed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("econnaborted") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("websocket error") ||
    msg.includes("closed before")
  );
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn) => Promise<T>,
  opts?: CdpSocketOptions,
): Promise<T> {
  const maxHandshakeRetries = normalizeRetryCount(opts?.handshakeRetries, 2);
  for (let attempt = 0; ; attempt += 1) {
    opts?.signal?.throwIfAborted();
    const ws = openCdpWebSocket(wsUrl, opts);
    const { send, closeWithError } = createCdpSender(ws, opts);

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
      ws.once("close", () => reject(new CdpSocketError("closed", "CDP socket closed")));
    });
    // A stalled HTTP upgrade must release its TCP socket on cancellation.
    const abortSocket = () => {
      closeWithError(toStringifiedError(opts?.signal?.reason));
      ws.terminate();
    };
    opts?.signal?.addEventListener("abort", abortSocket, { once: true });
    if (opts?.signal?.aborted) {
      abortSocket();
    }

    try {
      try {
        await openPromise;
      } catch (err) {
        closeWithError(toStringifiedError(err));
        opts?.signal?.throwIfAborted();
        if (attempt >= maxHandshakeRetries || !shouldRetryCdpHandshakeError(err)) {
          throw err;
        }
        // Retry only before commands can have side effects.
        await sleepWithAbort(computeHandshakeRetryDelayMs(attempt + 1, opts), opts?.signal).catch(
          (error: unknown) => {
            opts?.signal?.throwIfAborted();
            throw error;
          },
        );
        continue;
      }
      if (opts?.abortScope !== "operation") {
        opts?.signal?.removeEventListener("abort", abortSocket);
      } else {
        opts.signal?.throwIfAborted();
      }
      const result = await fn(send);
      if (opts?.abortScope === "operation") {
        opts.signal?.throwIfAborted();
      }
      return result;
    } catch (err) {
      closeWithError(toStringifiedError(err));
      throw err;
    } finally {
      opts?.signal?.removeEventListener("abort", abortSocket);
      ws.close();
    }
  }
}
