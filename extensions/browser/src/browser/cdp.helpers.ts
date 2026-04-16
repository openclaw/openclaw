import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
import {
  SsrFBlockedError,
  type SsrFPolicy,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import { redactSensitiveText } from "../logging/redact.js";
import { getDirectAgentForCdp, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { CDP_HTTP_REQUEST_TIMEOUT_MS, CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";
import { resolveBrowserRateLimitMessage } from "./rate-limit-message.js";

export { isLoopbackHost };

export function parseBrowserHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  const allowed = ["http:", "https:", "ws:", "wss:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : isSecure
        ? 443
        : 80;

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  return {
    parsed,
    port,
    normalized: parsed.toString().replace(/\/$/, ""),
  };
}

/**
 * Returns true when the URL uses a WebSocket protocol (ws: or wss:).
 * Used to distinguish direct-WebSocket CDP endpoints
 * from HTTP(S) endpoints that require /json/version discovery.
 */
export function isWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

export async function assertCdpEndpointAllowed(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  if (!ssrfPolicy) {
    return;
  }
  const parsed = new URL(cdpUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`Invalid CDP URL protocol: ${parsed.protocol.replace(":", "")}`);
  }
  try {
    const policy = isLoopbackHost(parsed.hostname)
      ? {
          ...ssrfPolicy,
          allowedHostnames: Array.from(
            new Set([...(ssrfPolicy?.allowedHostnames ?? []), parsed.hostname]),
          ),
        }
      : ssrfPolicy;
    await resolvePinnedHostnameWithPolicy(parsed.hostname, {
      policy,
    });
  } catch (error) {
    throw new BrowserCdpEndpointBlockedError({ cause: error });
  }
}

export function redactCdpUrl(cdpUrl: string | null | undefined): string | null | undefined {
  if (typeof cdpUrl !== "string") {
    return cdpUrl;
  }
  const trimmed = cdpUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    return redactSensitiveText(parsed.toString().replace(/\/$/, ""));
  } catch {
    return redactSensitiveText(trimmed);
  }
}

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => normalizeLowercaseStringOrEmpty(key) === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

export function normalizeCdpHttpBaseForJsonEndpoints(cdpUrl: string): string {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = url.pathname.replace(/\/devtools\/browser\/.*$/, "");
    url.pathname = url.pathname.replace(/\/cdp$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    // Best-effort fallback for non-URL-ish inputs.
    return cdpUrl
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/devtools\/browser\/.*$/, "")
      .replace(/\/cdp$/, "")
      .replace(/\/$/, "");
  }
}

type CdpFetchResult = {
  response: Response;
  release: () => Promise<void>;
};

function createCdpSender(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send: CdpSendFn = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const id = nextId++;
    const msg = { id, method, params, sessionId };
    ws.send(JSON.stringify(msg));
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on("error", (err) => {
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

export async function fetchJson<T>(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<T> {
  const { response, release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
  try {
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

export async function fetchCdpChecked(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<CdpFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  let guardedRelease: (() => Promise<void>) | undefined;
  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(t);
    await guardedRelease?.();
  };
  try {
    const headers = getHeadersWithAuth(url, (init?.headers as Record<string, string>) || {});
    const res = await withNoProxyForCdpUrl(url, async () => {
      const parsedUrl = new URL(url);
      const policy = isLoopbackHost(parsedUrl.hostname)
        ? {
            ...ssrfPolicy,
            allowedHostnames: Array.from(
              new Set([...(ssrfPolicy?.allowedHostnames ?? []), parsedUrl.hostname]),
            ),
          }
        : (ssrfPolicy ?? { allowPrivateNetwork: true });
      const guarded = await fetchWithSsrFGuard({
        url,
        init: { ...init, headers },
        signal: ctrl.signal,
        policy,
        auditContext: "browser-cdp",
      });
      guardedRelease = guarded.release;
      return guarded.response;
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Do not reflect upstream response text into the error surface (log/agent injection risk)
        throw new Error(`${resolveBrowserRateLimitMessage(url)} Do NOT retry the browser tool.`);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return { response: res, release };
  } catch (error) {
    await release();
    if (error instanceof SsrFBlockedError) {
      throw new BrowserCdpEndpointBlockedError({ cause: error });
    }
    throw error;
  }
}

export async function fetchOk(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  const { release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
  await release();
}

export function openCdpWebSocket(
  wsUrl: string,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): WebSocket {
  const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : CDP_WS_HANDSHAKE_TIMEOUT_MS;
  const agent = getDirectAgentForCdp(wsUrl);
  return new WebSocket(wsUrl, {
    handshakeTimeout: handshakeTimeoutMs,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(agent ? { agent } : {}),
  });
}

type CdpSocketOptions = {
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRetryCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 2;
  }
  return Math.max(0, Math.floor(value));
}

function computeRetryDelayMs(attempt: number, opts?: CdpSocketOptions): number {
  const baseDelayMs =
    typeof opts?.retryDelayMs === "number" && Number.isFinite(opts.retryDelayMs)
      ? Math.max(1, Math.floor(opts.retryDelayMs))
      : 200;
  const maxDelayMs =
    typeof opts?.maxRetryDelayMs === "number" && Number.isFinite(opts.maxRetryDelayMs)
      ? Math.max(baseDelayMs, Math.floor(opts.maxRetryDelayMs))
      : 3000;
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
  // Add 20% jitter to reduce thundering herd behavior on shared CDP endpoints.
  const jitterScale = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.floor(raw * jitterScale));
}

function shouldRetryCdpSocketError(err: unknown): boolean {
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
  return (
    msg.includes("cdp socket closed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("econnaborted") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("websocket is not open")
  );
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn) => Promise<T>,
  opts?: CdpSocketOptions,
): Promise<T> {
  const maxRetries = normalizeRetryCount(opts?.maxRetries);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const ws = openCdpWebSocket(wsUrl, opts);
    const { send, closeWithError } = createCdpSender(ws);

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
      ws.once("close", () => reject(new Error("CDP socket closed")));
    });

    try {
      await openPromise;
      return await fn(send);
    } catch (err) {
      lastErr = err;
      const normalizedErr = err instanceof Error ? err : new Error(String(err));
      closeWithError(normalizedErr);
      if (attempt > maxRetries || !shouldRetryCdpSocketError(normalizedErr)) {
        throw normalizedErr;
      }
      await sleep(computeRetryDelayMs(attempt, opts));
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }
  throw new Error("CDP socket failed");
}
