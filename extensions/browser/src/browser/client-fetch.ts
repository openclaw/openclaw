/**
 * Browser control client transport.
 *
 * Sends requests to either an absolute HTTP browser-control URL or the local
 * in-process dispatcher, adding loopback auth and operator-facing diagnostics.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-config";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfig } from "../config/config.js";
import { isLoopbackHost } from "../gateway/net.js";
import {
  getBridgeAuthForPort,
  SANDBOX_BROWSER_REFRESH_HEADER,
  SANDBOX_BROWSER_REFRESH_RETRY_AFTER_SECONDS,
  SANDBOX_BROWSER_REFRESH_VALUE,
} from "./bridge-auth-registry.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { resolveBrowserControlAuth } from "./control-auth.js";
import {
  parseBrowserErrorPayload,
  type BrowserNoDisplayErrorMetadata,
  type BrowserNoDisplayErrorDetails,
} from "./errors.js";
import { resolveBrowserRateLimitMessage } from "./rate-limit-message.js";

// Application-level error from the browser control service (service is reachable
// but returned an error response). Must NOT be wrapped with "Can't reach ..." messaging.
export class BrowserServiceError extends Error {
  readonly status?: number;
  readonly reason?: BrowserNoDisplayErrorMetadata["reason"];
  readonly details?: BrowserNoDisplayErrorDetails;

  constructor(message: string, metadata?: BrowserNoDisplayErrorMetadata, status?: number) {
    super(message);
    this.name = "BrowserServiceError";
    this.status = status;
    this.reason = metadata?.reason;
    this.details = metadata?.details;
  }
}

function browserServiceErrorFromPayload(
  value: unknown,
  fallback: string,
  status?: number,
): BrowserServiceError {
  const parsed = parseBrowserErrorPayload(value);
  return new BrowserServiceError(
    parsed?.error ?? fallback,
    parsed && "reason" in parsed ? parsed : undefined,
    status,
  );
}

type LoopbackBrowserAuthDeps = {
  getRuntimeConfig: typeof getRuntimeConfig;
  resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
  getBridgeAuthForPort: typeof getBridgeAuthForPort;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function withLoopbackBrowserAuthImpl(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  deps: LoopbackBrowserAuthDeps,
): RequestInit & { timeoutMs?: number } {
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("authorization") || headers.has("x-openclaw-password")) {
    return { ...init, headers };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ...init, headers };
  }

  try {
    const cfg = deps.getRuntimeConfig();
    const auth = deps.resolveBrowserControlAuth(cfg);
    if (auth.token) {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { ...init, headers };
    }
    if (auth.password) {
      headers.set("x-openclaw-password", auth.password);
      return { ...init, headers };
    }
  } catch {
    // ignore config/auth lookup failures and continue without auth headers
  }

  // Sandbox bridge servers can run with per-process ephemeral auth on dynamic ports.
  // Fall back to the in-memory registry if config auth is not available.
  try {
    const { port } = parseBrowserHttpUrl(url, "browser control URL");
    const bridgeAuth = deps.getBridgeAuthForPort(port);
    if (bridgeAuth?.token) {
      headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
    } else if (bridgeAuth?.password) {
      headers.set("x-openclaw-password", bridgeAuth.password);
    }
  } catch {
    // ignore
  }

  return { ...init, headers };
}

function withLoopbackBrowserAuth(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): RequestInit & { timeoutMs?: number } {
  return withLoopbackBrowserAuthImpl(url, init, {
    getRuntimeConfig,
    resolveBrowserControlAuth,
    getBridgeAuthForPort,
  });
}

const BROWSER_TOOL_MODEL_HINT =
  "Do NOT retry the browser tool — it will keep failing. " +
  "Use an alternative approach or inform the user that the browser is currently unavailable.";

const BROWSER_ERROR_BODY_LIMIT_BYTES = 16 * 1024;
// `response/body` supports 5M characters; 32 MiB covers worst-case JSON escaping while staying bounded.
const BROWSER_SUCCESS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const SANDBOX_BROWSER_RECONNECT_RETRY_MS = 50;

function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

function isRegisteredLoopbackBridgeUrl(url: string): boolean {
  if (!isLoopbackHttpUrl(url)) {
    return false;
  }
  try {
    const explicitPort = new URL(url).port;
    const port = explicitPort ? Number(explicitPort) : 0;
    return Number.isSafeInteger(port) && port > 0 && getBridgeAuthForPort(port) !== undefined;
  } catch {
    return false;
  }
}

function resolveSandboxBrowserRefreshDelayMs(res: Response): number | undefined {
  if (
    res.status !== 503 ||
    res.headers.get(SANDBOX_BROWSER_REFRESH_HEADER) !== SANDBOX_BROWSER_REFRESH_VALUE
  ) {
    return undefined;
  }
  const raw = res.headers.get("retry-after")?.trim();
  if (raw && /^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, SANDBOX_BROWSER_REFRESH_RETRY_AFTER_SECONDS * 1000);
    }
  }
  return SANDBOX_BROWSER_REFRESH_RETRY_AFTER_SECONDS * 1000;
}

type SandboxBrowserReconnectFailure = "preconnect" | "ambiguous";

function classifySandboxBrowserReconnectFailure(
  err: unknown,
): SandboxBrowserReconnectFailure | null {
  const error =
    (typeof err === "object" || typeof err === "function") && err !== null
      ? (err as { cause?: unknown; code?: unknown })
      : undefined;
  const cause =
    typeof error?.cause === "object" && error.cause !== null
      ? (error.cause as { code?: unknown })
      : undefined;
  const codes = [error?.code, cause?.code]
    .filter((code): code is string => typeof code === "string")
    .map((code) => code.toUpperCase());
  if (codes.includes("ECONNREFUSED")) {
    return "preconnect";
  }
  if (codes.some((code) => ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code))) {
    return "ambiguous";
  }
  const message = normalizeLowercaseStringOrEmpty(
    `${normalizeErrorMessage(err)} ${cause === undefined ? "" : normalizeErrorMessage(cause)}`,
  );
  if (/\b(?:connection refused|econnrefused)\b/.test(message)) {
    return "preconnect";
  }
  return /connection reset|socket hang up|fetch failed/.test(message) ? "ambiguous" : null;
}

function allowsAmbiguousBrowserReconnectRetry(method: string | undefined): boolean {
  // A reset can happen after a mutation was dispatched. Only reads are safe
  // to replay when the transport cannot prove the request stayed pre-connect.
  const normalized = normalizeLowercaseStringOrEmpty(method) || "get";
  return normalized === "get" || normalized === "head";
}

async function waitForSandboxBrowserRetry(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    throw toLintErrorObject(signal.reason, "Browser control request aborted");
  }
}

type BrowserControlOwnership = "local-managed" | "external-browser" | "unknown";

function resolveDispatcherBrowserControlOwnership(url: string): BrowserControlOwnership {
  if (isAbsoluteHttp(url)) {
    return "unknown";
  }
  try {
    const cfg = getRuntimeConfig();
    const resolved = resolveBrowserConfig(cfg?.browser, cfg);
    const parsed = new URL(url, "http://localhost");
    const requestedProfile = parsed.searchParams.get("profile")?.trim();
    const profile = resolveProfile(resolved, requestedProfile || resolved.defaultProfile);
    if (!profile) {
      return "unknown";
    }
    return profile.driver === "openclaw" && profile.cdpIsLoopback && !profile.attachOnly
      ? "local-managed"
      : "external-browser";
  } catch {
    return "unknown";
  }
}

function resolveBrowserFetchOperatorHint(
  url: string,
  opts?: { ownership?: BrowserControlOwnership },
): string {
  if (opts?.ownership === "external-browser") {
    return (
      "The browser profile is external to OpenClaw; make sure its browser/CDP endpoint " +
      "is running and reachable. Restarting the OpenClaw gateway will not launch it."
    );
  }
  const isLocal = !isAbsoluteHttp(url);
  return isLocal
    ? `Restart the OpenClaw gateway (OpenClaw.app menubar, or \`${formatCliCommand("openclaw gateway")}\`).`
    : "If this is a sandboxed session, ensure the sandbox browser is running.";
}

function normalizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? normalizeOptionalString(err.message) : undefined;
  if (message) {
    return message;
  }
  return String(err);
}

function appendBrowserToolModelHint(message: string): string {
  if (message.includes(BROWSER_TOOL_MODEL_HINT)) {
    return message;
  }
  return `${message} ${BROWSER_TOOL_MODEL_HINT}`;
}

type BrowserFetchFailureKind = "timeout" | "aborted" | "persistent";

function resolveBrowserFetchTimeoutMs(timeoutMs: number | undefined): number {
  return resolveTimerTimeoutMs(timeoutMs, 5000);
}

function classifyBrowserFetchFailure(err: unknown): BrowserFetchFailureKind {
  const msg = normalizeErrorMessage(err);
  const msgLower = normalizeLowercaseStringOrEmpty(msg);
  const nameLower = err instanceof Error ? normalizeLowercaseStringOrEmpty(err.name) : "";
  const looksLikeTimeout =
    nameLower.includes("timeout") || msgLower.includes("timed out") || msgLower.includes("timeout");
  if (looksLikeTimeout) {
    return "timeout";
  }
  const looksLikeAbort =
    nameLower === "aborterror" ||
    msgLower.includes("aborterror") ||
    msgLower.includes("aborted") ||
    msgLower.includes("abort") ||
    msgLower.includes("cancelled") ||
    msgLower.includes("canceled");
  return looksLikeAbort ? "aborted" : "persistent";
}

async function discardResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best effort only; we're already returning a stable error message.
  }
}

async function parseBrowserHttpResponse<T>(url: string, res: Response): Promise<T> {
  if (!res.ok) {
    if (isRateLimitStatus(res.status)) {
      // Do not reflect upstream response text into the error surface (log/agent injection risk)
      await discardResponseBody(res);
      throw new BrowserServiceError(
        `${resolveBrowserRateLimitMessage(url)} ${BROWSER_TOOL_MODEL_HINT}`,
      );
    }
    // Overflow cancels the stream and releases its reader lock before the guarded fetch below.
    const body = await readResponseWithLimit(res, BROWSER_ERROR_BODY_LIMIT_BYTES).catch(
      () => undefined,
    );
    const text = body ? new TextDecoder().decode(body) : "";
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Plain-text errors remain part of the existing browser-control contract.
      }
    }
    throw browserServiceErrorFromPayload(parsed, text || `HTTP ${res.status}`, res.status);
  }
  const body = await readResponseWithLimit(res, BROWSER_SUCCESS_BODY_LIMIT_BYTES, {
    onOverflow: ({ maxBytes }) =>
      new BrowserServiceError(`Browser control response exceeded ${maxBytes} bytes`),
  });
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

function enhanceDispatcherPathError(url: string, err: unknown): Error {
  const msg = normalizeErrorMessage(err);
  const kind = classifyBrowserFetchFailure(err);
  const ownership = resolveDispatcherBrowserControlOwnership(url);
  const operatorHint = resolveBrowserFetchOperatorHint(url, { ownership });
  const suffix =
    kind === "persistent" ? `${operatorHint} ${BROWSER_TOOL_MODEL_HINT}` : operatorHint;
  const normalized = msg.endsWith(".") ? msg : `${msg}.`;
  return new Error(`${normalized} ${suffix}`, err instanceof Error ? { cause: err } : undefined);
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const operatorHint = resolveBrowserFetchOperatorHint(url);
  const msg = normalizeErrorMessage(err);
  const kind = classifyBrowserFetchFailure(err);
  if (kind === "timeout") {
    return new Error(
      `Can't reach the OpenClaw browser control service (timed out after ${timeoutMs}ms). ${operatorHint}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  if (kind === "aborted") {
    return new Error(
      `Browser control request was cancelled. ${operatorHint}`,
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  return new Error(
    appendBrowserToolModelHint(
      `Can't reach the OpenClaw browser control service. ${operatorHint} (${msg})`,
    ),
    err instanceof Error ? { cause: err } : undefined,
  );
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = resolveBrowserFetchTimeoutMs(init.timeoutMs);
  // Resolve bridge ownership before the first attempt. The registry is briefly
  // absent while a replacement bridge rebinds its stable loopback port.
  const registeredLoopbackBridge = isRegisteredLoopbackBridgeUrl(url);
  const ctrl = new AbortController();
  const upstreamSignal = init.signal;
  let upstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      ctrl.abort(upstreamSignal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }

  const t = setTimeout(() => ctrl.abort(new Error("timed out")), timeoutMs);
  const allowAmbiguousReconnectRetry = allowsAmbiguousBrowserReconnectRetry(init.method);
  let refreshRetryArmed = false;
  try {
    while (true) {
      let release: (() => Promise<void>) | undefined;
      try {
        let res: Response;
        try {
          const guarded = await fetchWithSsrFGuard({
            url,
            init,
            signal: ctrl.signal,
            policy: { allowPrivateNetwork: true },
            auditContext: "browser-control-client",
          });
          release = guarded.release;
          res = guarded.response;
        } catch (err) {
          const reconnectFailure = classifySandboxBrowserReconnectFailure(err);
          const reconnectRetryAllowed =
            reconnectFailure === "preconnect" ||
            (reconnectFailure === "ambiguous" && allowAmbiguousReconnectRetry);
          if (!refreshRetryArmed || ctrl.signal.aborted || !reconnectRetryAllowed) {
            throw err;
          }
          await waitForSandboxBrowserRetry(SANDBOX_BROWSER_RECONNECT_RETRY_MS, ctrl.signal);
          continue;
        }

        const retryDelayMs = registeredLoopbackBridge
          ? resolveSandboxBrowserRefreshDelayMs(res)
          : undefined;
        if (retryDelayMs !== undefined) {
          refreshRetryArmed = true;
          await discardResponseBody(res);
          // Release the SSRF guard before sleeping or opening the next connection.
          await release();
          release = undefined;
          await waitForSandboxBrowserRetry(retryDelayMs, ctrl.signal);
          continue;
        }
        return await parseBrowserHttpResponse<T>(url, res);
      } finally {
        await release?.();
      }
    }
  } finally {
    clearTimeout(t);
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

/** Fetch JSON from browser control over HTTP or local dispatcher transport. */
export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = resolveBrowserFetchTimeoutMs(init?.timeoutMs);
  let isDispatcherPath = false;
  try {
    if (isAbsoluteHttp(url)) {
      const httpInit = withLoopbackBrowserAuth(url, init);
      return await fetchHttpJson<T>(url, { ...httpInit, timeoutMs });
    }
    isDispatcherPath = true;
    const { dispatchBrowserControlRequest } = await import("./local-dispatch.runtime.js");
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string
      }
    }

    const abortCtrl = new AbortController();
    const upstreamSignal = init?.signal;
    let upstreamAbortListener: (() => void) | undefined;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        abortCtrl.abort(upstreamSignal.reason);
      } else {
        upstreamAbortListener = () => abortCtrl.abort(upstreamSignal.reason);
        upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
      }
    }

    let abortListener: (() => void) | undefined;
    const abortPromise: Promise<never> = abortCtrl.signal.aborted
      ? Promise.reject(
          toLintErrorObject(abortCtrl.signal.reason ?? new Error("aborted"), "Non-Error rejection"),
        )
      : new Promise((_, reject) => {
          abortListener = () =>
            reject(
              toLintErrorObject(
                abortCtrl.signal.reason ?? new Error("aborted"),
                "Non-Error rejection",
              ),
            );
          abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
        });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => abortCtrl.abort(new Error("timed out")), timeoutMs);
    }

    const dispatchPromise = dispatchBrowserControlRequest({
      method:
        init?.method?.toUpperCase() === "DELETE"
          ? "DELETE"
          : init?.method?.toUpperCase() === "POST"
            ? "POST"
            : "GET",
      path: parsed.pathname,
      query,
      body,
      signal: abortCtrl.signal,
    });

    const result = await Promise.race([dispatchPromise, abortPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
      if (abortListener) {
        abortCtrl.signal.removeEventListener("abort", abortListener);
      }
      if (upstreamSignal && upstreamAbortListener) {
        upstreamSignal.removeEventListener("abort", upstreamAbortListener);
      }
    });

    if (result.status >= 400) {
      if (isRateLimitStatus(result.status)) {
        // Do not reflect upstream response text into the error surface (log/agent injection risk)
        throw new BrowserServiceError(
          `${resolveBrowserRateLimitMessage(url)} ${BROWSER_TOOL_MODEL_HINT}`,
        );
      }
      throw browserServiceErrorFromPayload(result.body, `HTTP ${result.status}`, result.status);
    }
    return result.body as T;
  } catch (err) {
    if (err instanceof BrowserServiceError) {
      throw err;
    }
    // Dispatcher-path failures are service-operation failures, not network
    // reachability failures. Keep the original context, but retain anti-retry hints.
    if (isDispatcherPath) {
      throw enhanceDispatcherPathError(url, err);
    }
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}

/** Focused test hooks for browser client transport internals. */
export const testApi = {
  withLoopbackBrowserAuth: withLoopbackBrowserAuthImpl,
};
export { testApi as __test };

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
