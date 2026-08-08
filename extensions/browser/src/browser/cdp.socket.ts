/** Low-level CDP WebSocket helpers with cancellation and bounded retries. */
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import WebSocket from "ws";
import { rawDataToString } from "../infra/ws.js";
import { getDirectAgentForCdp, withManagedProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { normalizeBrowserTimerDelayMs } from "./timer-delay.js";

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

function decodeUrlUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Merge URL basic-auth credentials into headers without overriding explicit auth. */
export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => key.trim().toLowerCase() === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const username = decodeUrlUserInfo(parsed.username);
      const password = decodeUrlUserInfo(parsed.password);
      const auth = Buffer.from(`${username}:${password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

/** Remove URL userinfo after callers have converted it to an Authorization header. */
export function stripCdpUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) {
      return url;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function createCdpSender(ws: WebSocket, opts?: { commandTimeoutMs?: number }) {
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
        reject(new Error("CDP socket closed"));
        return;
      }
      const entry: Pending = { resolve, reject };
      if (commandTimeoutMs !== undefined) {
        // A timed-out command closes the whole socket so pending calls do not
        // hang on a connection whose CDP command stream is no longer reliable.
        entry.timer = setTimeout(() => {
          closeWithError(new Error(`CDP command ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
      }
      pending.set(id, entry);
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        pending.delete(id);
        clearPendingTimer(entry);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      clearPendingTimer(p);
      p.reject(err);
    }
    pending.clear();
    ws.close();
  };

  ws.on("error", (err) => {
    // The `err instanceof Error` guard is defensive: Node's `ws` library
    // always emits Error instances on the 'error' event. Triggering the
    // non-Error branch would require synthetically emitting on the socket,
    // which the library treats as an unhandled error and hangs the test.
    /* c8 ignore next */
    closeWithError(err instanceof Error ? err : new Error(String(err)));
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
        p.reject(new Error(parsed.error.message));
        return;
      }
      p.resolve(parsed.result);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    closeWithError(new Error("CDP socket closed"));
  });

  return { send, closeWithError };
}

/** Open a CDP WebSocket with URL basic-auth and proxy bypass handling. */
export function openCdpWebSocket(
  wsUrl: string,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): WebSocket {
  const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : CDP_WS_HANDSHAKE_TIMEOUT_MS;
  const connectionUrl = stripCdpUrlCredentials(wsUrl);
  const agent = getDirectAgentForCdp(connectionUrl);
  return withManagedProxyForCdpUrl(
    connectionUrl,
    () =>
      new WebSocket(connectionUrl, {
        handshakeTimeout: handshakeTimeoutMs,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(agent ? { agent } : {}),
      }),
  );
}

type CdpSocketOptions = {
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  handshakeRetries?: number;
  handshakeRetryDelayMs?: number;
  handshakeMaxRetryDelayMs?: number;
  signal?: AbortSignal;
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
      ws.once("close", () => reject(new Error("CDP socket closed")));
    });
    // Cancellation owns the whole socket attempt, from opening handshake
    // through the final callback command.
    const abortOperation = () => {
      const reason = opts?.signal?.reason;
      const error = reason instanceof Error ? reason : new Error("CDP operation aborted");
      closeWithError(error);
      ws.terminate();
    };
    opts?.signal?.addEventListener("abort", abortOperation, { once: true });
    if (opts?.signal?.aborted) {
      abortOperation();
    }

    try {
      await openPromise;
    } catch (err) {
      // openPromise is only rejected via `ws.once('error', err => reject(err))`
      // or the close event's `new Error(...)`; the former always carries an
      // Error from Node's `ws` library, the latter is already an Error. The
      // non-Error wrap is defensive and structurally unreachable.
      /* c8 ignore next */
      closeWithError(err instanceof Error ? err : new Error(String(err)));
      // Cancellation on the final attempt must not become a handshake error.
      opts?.signal?.throwIfAborted();
      if (attempt >= maxHandshakeRetries || !shouldRetryCdpHandshakeError(err)) {
        opts?.signal?.removeEventListener("abort", abortOperation);
        throw err;
      }
      // Retry only handshake failures. Once CDP commands are flowing, callers
      // own retry semantics because commands may already have side effects.
      // Cancelled route requests must not keep retrying Chrome handshakes.
      await sleepWithAbort(computeHandshakeRetryDelayMs(attempt + 1, opts), opts?.signal).catch(
        (error: unknown) => {
          opts?.signal?.throwIfAborted();
          throw error;
        },
      );
      opts?.signal?.removeEventListener("abort", abortOperation);
      continue;
    }

    try {
      opts?.signal?.throwIfAborted();
      const result = await fn(send);
      opts?.signal?.throwIfAborted();
      return result;
    } catch (err) {
      closeWithError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      opts?.signal?.removeEventListener("abort", abortOperation);
      ws.close();
    }
  }
}
