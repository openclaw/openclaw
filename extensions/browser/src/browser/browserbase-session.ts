// Browserbase keep-alive session resolver.
//
// Background: Browserbase issues a Chrome DevTools Protocol (CDP) `connectUrl`
// per session that embeds a short-lived signing key. The signing key rotates
// well before the session itself expires, so a `cdpUrl` snapshotted at config
// load time stops working long before the session does. The fix is to fetch a
// fresh `connectUrl` from `GET /v1/sessions/<id>` on every CDP attach.
//
// This module is intentionally narrow:
//   - One exported function: `fetchBrowserbaseConnectUrl`.
//   - Three named error classes so operator logs name the failure mode
//     without parsing message strings.
//   - `withResolvedCdpUrl` is a thin shim used by call sites that hold a
//     `ResolvedBrowserProfile`; for non-browserbase drivers it returns the
//     input unchanged (zero-cost), for browserbase drivers it returns a
//     shallow copy with the freshly resolved `cdpUrl` / `cdpHost` /
//     `cdpIsLoopback` fields.
//
// Caching is intentionally absent: the whole point of the driver is signing
// key rotation, and any cache larger than zero defeats it.
//
// Docs: https://docs.browserbase.com/platform/browser/long-sessions/keep-alive

import type { ResolvedBrowserProfile } from "./config.js";

const BROWSERBASE_API_BASE = "https://api.browserbase.com";
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

/**
 * The configured `browserbaseApiKeyEnv` is missing from `process.env`, or the
 * value is empty/whitespace. Operators see this when they forget to wire the
 * 1Password injection or systemd `EnvironmentFile=`.
 */
export class BrowserbaseAuthConfigError extends Error {
  readonly envVarName: string;

  constructor(envVarName: string) {
    super(
      `Browserbase API key env var "${envVarName}" is not set or empty. ` +
        `Set ${envVarName}=<api-key> (or change the profile's browserbaseApiKeyEnv).`,
    );
    this.name = "BrowserbaseAuthConfigError";
    this.envVarName = envVarName;
  }
}

/**
 * `GET /v1/sessions/<id>` returned successfully but the session is no longer
 * in a state that can accept CDP attaches (`COMPLETED`, `ERROR`, `TIMED_OUT`,
 * `REQUEST_RELEASE`, etc.). The `status` field is preserved verbatim so the
 * operator can decide whether to mint a new session or investigate.
 */
export class BrowserbaseSessionUnavailableError extends Error {
  readonly sessionId: string;
  readonly status: string;

  constructor(sessionId: string, status: string) {
    super(
      `Browserbase session "${sessionId}" is not RUNNING (status="${status}"). ` +
        `Mint a fresh keep-alive session and update browserbaseSessionId.`,
    );
    this.name = "BrowserbaseSessionUnavailableError";
    this.sessionId = sessionId;
    this.status = status;
  }
}

/**
 * Browserbase returned 2xx but the response body did not contain a non-empty
 * `connectUrl` string. This should not happen against the documented v1 API;
 * if it does the error is loud rather than silently falling through to a
 * meaningless empty URL.
 */
export class BrowserbaseSessionMalformedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, detail: string) {
    super(`Browserbase session "${sessionId}" response missing connectUrl: ${detail}`);
    this.name = "BrowserbaseSessionMalformedError";
    this.sessionId = sessionId;
  }
}

export type BrowserbaseSessionResponse = {
  status: string;
  connectUrl: string;
};

export type FetchBrowserbaseConnectUrlOptions = {
  /** Hard cap on the HTTP round-trip. Defaults to 8000ms. */
  timeoutMs?: number;
  /** Caller-supplied abort signal; honored alongside the internal timeout. */
  signal?: AbortSignal;
  /**
   * Test-only injection point for the underlying fetch. Production callers
   * leave this undefined; tests pass a `vi.fn()` so the module under test
   * never reaches the real network.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test-only injection point for environment lookups. Production callers
   * leave this undefined; tests pass an explicit map to keep the global
   * `process.env` immutable across parallel test cases.
   */
  envLookup?: (name: string) => string | undefined;
};

/**
 * Resolve a Browserbase keep-alive session to a fresh CDP `connectUrl`.
 *
 * Behavior:
 *   - Reads the API key from `process.env[apiKeyEnv]` (or `envLookup` if
 *     provided for tests). Throws `BrowserbaseAuthConfigError` if absent.
 *   - Issues `GET /v1/sessions/<sessionId>` with header `X-BB-API-Key`.
 *   - Default timeout is 8s; can be tightened with `opts.timeoutMs`.
 *   - Honors a caller-supplied `AbortSignal` alongside the internal timeout.
 *   - Throws `BrowserbaseSessionUnavailableError` when `status !== "RUNNING"`.
 *   - Throws `BrowserbaseSessionMalformedError` when `connectUrl` is missing
 *     or not a non-empty string.
 *   - Surfaces non-2xx HTTP responses with the status code in the message
 *     and a hint about the API key for 401/403.
 *   - Does NOT cache. Two calls = two HTTP requests by design.
 */
export async function fetchBrowserbaseConnectUrl(
  sessionId: string,
  apiKeyEnv: string,
  opts: FetchBrowserbaseConnectUrlOptions = {},
): Promise<string> {
  const envLookup = opts.envLookup ?? ((name: string) => process.env[name]);
  const rawKey = envLookup(apiKeyEnv);
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!apiKey) {
    throw new BrowserbaseAuthConfigError(apiKeyEnv);
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Math.floor(opts.timeoutMs as number))
    : DEFAULT_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Combine the internal timeout with any caller-supplied abort. We always
  // create our own controller so we can abort on timeout even when no caller
  // signal exists.
  const internalCtrl = new AbortController();
  const timeoutHandle = setTimeout(() => internalCtrl.abort(), timeoutMs);
  const onExternalAbort = () => internalCtrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timeoutHandle);
      throw makeAbortError("Browserbase session fetch aborted by caller");
    }
    opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const url = `${BROWSERBASE_API_BASE}/v1/sessions/${encodeURIComponent(sessionId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "X-BB-API-Key": apiKey,
        Accept: "application/json",
      },
      signal: internalCtrl.signal,
    });
  } catch (err) {
    if (isAbortLikeError(err)) {
      const reason = opts.signal?.aborted
        ? "Browserbase session fetch aborted by caller"
        : `Browserbase session fetch timed out after ${timeoutMs}ms`;
      throw makeAbortError(reason);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  if (!response.ok) {
    const status = response.status;
    const hint =
      status === 401 || status === 403
        ? ` Check that ${apiKeyEnv} is set to a valid Browserbase API key.`
        : "";
    throw new Error(`Browserbase /v1/sessions/${sessionId} returned HTTP ${status}.${hint}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new BrowserbaseSessionMalformedError(
      sessionId,
      `response was not valid JSON: ${(err as Error).message}`,
    );
  }

  const parsed = body as Partial<BrowserbaseSessionResponse> | null | undefined;
  const status = typeof parsed?.status === "string" ? parsed.status : "";
  if (status !== "RUNNING") {
    throw new BrowserbaseSessionUnavailableError(sessionId, status || "<missing>");
  }

  const connectUrl = typeof parsed?.connectUrl === "string" ? parsed.connectUrl.trim() : "";
  if (!connectUrl) {
    throw new BrowserbaseSessionMalformedError(sessionId, "connectUrl field was missing or empty");
  }

  return connectUrl;
}

/**
 * For non-browserbase drivers returns the profile unchanged. For
 * `driver === "browserbase"` returns a shallow copy with the freshly fetched
 * `cdpUrl`, recomputed `cdpHost`, and `cdpIsLoopback: false`.
 *
 * The original profile object is never mutated. Callers can rely on the
 * returned profile having a populated `cdpUrl` (or the call throws).
 *
 * NOTE: This helper deliberately does NOT cache. Every call hits Browserbase.
 * That is the entire point of the driver — see file header comment.
 */
export async function withResolvedCdpUrl(
  profile: ResolvedBrowserProfile,
  opts?: FetchBrowserbaseConnectUrlOptions,
): Promise<ResolvedBrowserProfile> {
  if (profile.driver !== "browserbase") {
    return profile;
  }
  const sessionId = profile.browserbaseSessionId;
  const apiKeyEnv = profile.browserbaseApiKeyEnv;
  if (!sessionId || !apiKeyEnv) {
    // Should be unreachable: `resolveProfile` validates these at config
    // load time. Raise loudly if a future refactor drops the validation.
    throw new Error(
      `Profile "${profile.name}" is driver=browserbase but missing ` +
        `browserbaseSessionId or browserbaseApiKeyEnv.`,
    );
  }
  const connectUrl = await fetchBrowserbaseConnectUrl(sessionId, apiKeyEnv, opts);
  // Recompute host. Browserbase URLs are wss://, never loopback.
  let host = "";
  try {
    host = new URL(connectUrl).hostname;
  } catch {
    // Treat as malformed; same error class as the resolver path so
    // operator log lines stay legible.
    throw new BrowserbaseSessionMalformedError(
      sessionId,
      `connectUrl did not parse as a URL: ${connectUrl.slice(0, 80)}`,
    );
  }
  return {
    ...profile,
    cdpUrl: connectUrl,
    cdpHost: host,
    cdpIsLoopback: false,
  };
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}
