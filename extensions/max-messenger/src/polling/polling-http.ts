/**
 * Custom HTTP wrapper for the MAX channel polling supervisor (per
 * docs/max-plugin/plan.md §6.1.6 / §9 N4).
 *
 * Closes the gaps in `@maxhub/max-bot-api` 0.2.2's shipped client (per audit
 * in §6.1.1):
 *
 * - Wires a composed `AbortSignal` (caller signal + per-request
 *   `AbortSignal.timeout(...)`) into `fetch`. The SDK's own client never
 *   passes a signal, which is why a hung long-poll there can stall the loop
 *   indefinitely.
 * - Reads `Retry-After` from 429 responses (sec-int and HTTP-date forms) and
 *   surfaces it through a typed `RetryAfterError` so the loop can sleep the
 *   server-given duration instead of the SDK's hard-coded 5 s.
 * - Maps 401 → `UnauthorizedError` (loop treats as fatal, halts polling and
 *   surfaces "unauthorized" status to the gateway).
 * - Maps 5xx → `ServerError` (loop treats as transient → exponential backoff).
 * - Maps undici/Node `TypeError` (with cause `AbortError`/`SocketError` or a
 *   timeout reason) into `NetworkError` / `TimeoutError` so we can distinguish
 *   "MAX-edge dropped us" from "we hit our own per-request timeout" from
 *   "caller canceled (gateway shutdown)".
 *
 * Used by both polling (`GET /updates`) and outbound (`POST /messages`) so
 * the two share retry semantics. The `MaxError` thrown by the SDK's own
 * `BaseApi.callApi` is intentionally NOT used here — bypassing the SDK's
 * client is the whole point per §9 N2 resolution.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 40_000;

/** Token revoked or invalid. Loop treats as fatal — no retries, halt. */
export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "MAX API responded with 401 (unauthorized).") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Generic 5xx (or unexpected non-200/401/429). Loop treats as transient. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`MAX API responded with ${status}.`);
    this.name = "ServerError";
  }
}

/** undici/Node level fetch failure (DNS, socket close, RST). Transient. */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/** Per-request `AbortSignal.timeout(...)` fired before the response arrived. Transient. */
export class TimeoutError extends Error {
  constructor(readonly requestTimeoutMs: number) {
    super(`MAX API request exceeded ${requestTimeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

/**
 * 429 with `Retry-After`. `retryAfterMs` is parsed from the header (sec-int or
 * HTTP-date) and reflects exactly the server-requested wait. The loop honors
 * this without further multiplicative backoff.
 */
export class RetryAfterError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly status: number,
  ) {
    super(`MAX API responded with ${status}; Retry-After ${retryAfterMs}ms.`);
    this.name = "RetryAfterError";
  }
}

export type PollingHttpRequest = {
  apiRoot: string;
  /** Path beginning with `/`, e.g. `/updates` or `/messages`. */
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Bot token; sent as raw `Authorization: <token>` per SDK convention. */
  token: string;
  /** Query parameters (numbers/booleans coerced via String()). */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON-serializable body (sent as `application/json`). */
  body?: unknown;
  /** Caller-driven cancellation (e.g. gateway abortSignal). */
  signal?: AbortSignal;
  /** Per-request timeout. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Fetch override for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * Build the per-request signal: caller signal (or absent) composed with
 * `AbortSignal.timeout(requestTimeoutMs)`. Returns the composed signal plus a
 * predicate to identify which side fired so the caller can throw the right
 * typed error.
 */
function composeRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; isTimeout: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) {
    return {
      signal: timeoutSignal,
      isTimeout: () => timeoutSignal.aborted,
    };
  }
  // AbortSignal.any composes — fires when either input fires.
  const composed = AbortSignal.any([callerSignal, timeoutSignal]);
  return {
    signal: composed,
    isTimeout: () => timeoutSignal.aborted && !callerSignal.aborted,
  };
}

function buildUrl(apiRoot: string, path: string, query?: PollingHttpRequest["query"]): string {
  const root = apiRoot.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${root}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

/**
 * Parse the `Retry-After` header. Returns delay in ms, or null when the header
 * is absent / unparseable. Both forms from RFC 7231 §7.1.3 are supported:
 *
 *   - delta-seconds (integer, e.g. "120") → 120 * 1000 ms
 *   - HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT") → ms until that date,
 *     clamped at 0 when the date is already in the past.
 */
export function parseRetryAfterMs(
  header: string | null,
  now: () => number = Date.now,
): number | null {
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return seconds * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, parsed - now());
}

/**
 * Distinguish abort caused by our timeout vs by the caller. Caller-driven
 * AbortError propagates as-is so the loop can exit cleanly on gateway shutdown
 * without classifying it as a transport failure.
 *
 * Node 22+ undici's `fetch` reports two flavors of abort via `DOMException`:
 *   - `name = "AbortError"`   when the controller was aborted manually.
 *   - `name = "TimeoutError"` when `AbortSignal.timeout(...)` fired.
 *
 * Both indicate "abort", not transport failure. The caller still distinguishes
 * caller-driven vs timeout via the `isTimeout()` predicate from
 * `composeRequestSignal`, so this helper just answers "did the request abort?"
 */
function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return true;
    }
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return true;
    }
    // undici occasionally wraps the abort in a TypeError with a DOMException cause.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof DOMException) {
      if (cause.name === "AbortError" || cause.name === "TimeoutError") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Issue a typed request against MAX. Returns the parsed JSON body on 2xx; on
 * non-2xx responses or transport failures throws one of the typed errors
 * defined at the top of this file.
 */
export async function pollingHttpRequest<T = unknown>(req: PollingHttpRequest): Promise<T> {
  const requestTimeoutMs = req.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const { signal, isTimeout } = composeRequestSignal(req.signal, requestTimeoutMs);
  const url = buildUrl(req.apiRoot, req.path, req.query);
  const headers: Record<string, string> = { Authorization: req.token };
  let initBody: BodyInit | undefined;
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    initBody = JSON.stringify(req.body);
  }
  const fetchImpl = req.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: req.method,
      headers,
      ...(initBody !== undefined ? { body: initBody } : {}),
      signal,
    });
  } catch (err) {
    if (isAbortLikeError(err)) {
      if (isTimeout()) {
        throw new TimeoutError(requestTimeoutMs);
      }
      // Caller-driven cancellation — bubble up so the loop can exit on shutdown.
      throw err;
    }
    throw new NetworkError(
      `MAX fetch failed for ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs !== null) {
      // Drain the body so the connection can be reused.
      await response.text().catch(() => undefined);
      throw new RetryAfterError(retryAfterMs, response.status);
    }
    // No usable header — degrade to ServerError so the loop applies its own
    // backoff. This is the compromise per §6.1.6: honor Retry-After when
    // present, fall back to exponential backoff otherwise.
    const fallbackBody = await safeReadJson(response);
    throw new ServerError(response.status, fallbackBody);
  }

  if (response.status >= 200 && response.status < 300) {
    return (await safeReadJson(response)) as T;
  }

  // Anything else (5xx, unexpected 4xx) — transient ServerError. The loop
  // applies exponential backoff.
  const errorBody = await safeReadJson(response);
  throw new ServerError(response.status, errorBody);
}

async function safeReadJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}
