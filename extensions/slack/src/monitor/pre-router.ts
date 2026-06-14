/**
 * Optional env-gated HTTP pre-router hook for the Slack monitor.
 *
 * Some workspaces front the Slack monitor with an external
 * pattern-matcher service (a Python skill_matcher, a static FAQ
 * responder, anything that wants to answer common prompts without
 * an LLM round-trip). This hook lets that external service inspect
 * a prompt BEFORE the agent turn is created.
 *
 * Behavior
 * --------
 *
 *   OPENCLAW_PRE_ROUTER_URL unset       → no-op, returns null
 *                                        (LLM dispatch unchanged)
 *   set + HTTP 200 matched=true         → returns the response text
 *                                        (caller posts it + skips LLM)
 *   set + HTTP 200 matched=false        → returns null
 *   set + HTTP 500 / timeout / parse-fail → returns null
 *
 * The hook is "fails-safe": ANY error returns null so the bot
 * always falls through to LLM dispatch. A broken pre-router service
 * cannot break the Slack bot.
 *
 * Security
 * --------
 *
 * ``OPENCLAW_PRE_ROUTER_URL`` must point to a trusted service. The
 * operator chooses what URL to set; we don't validate it beyond
 * "looks like a URL". Treat it like any other trusted internal
 * service URL — do not point it at an untrusted host that could
 * inject arbitrary text into your Slack workspace.
 *
 * The hook sends the raw user prompt to the configured URL. Operators
 * who don't want user messages leaving their boundary should leave
 * the env var unset.
 */

const DEFAULT_PRE_ROUTER_TIMEOUT_MS = 2000;

/**
 * Request payload posted to the pre-router URL.
 *
 * ``prompt`` is the raw user text from the Slack message.
 * ``channel``, ``user``, ``ts`` are Slack identifiers — opaque to the
 * pre-router service, included so it can correlate with Slack thread
 * URLs in its own logs.
 */
export interface PreRouterRequest {
  prompt: string;
  channel: string;
  user: string;
  ts: string;
}

/**
 * Response shape expected from the pre-router URL.
 *
 * On ``matched: true``, ``response`` MUST be a non-empty string —
 * this is what gets posted to Slack. On ``matched: false``, the
 * other fields are ignored and the hook returns null.
 *
 * Any other shape (missing ``matched`` field, wrong types, etc.) is
 * treated as malformed and falls through to LLM dispatch.
 */
export interface PreRouterResponse {
  matched: boolean;
  response?: string;
  error?: string;
  pattern_id?: string;
  latency_ms?: number;
}

/** Per-call dependencies, dependency-injected for unit testing. */
export interface PreRouterDeps {
  /** Reads the URL env var. Pass () => undefined to disable. */
  readUrl?: () => string | undefined;
  /** Reads the timeout env var. */
  readTimeoutMs?: () => number;
  /** HTTP client. Override in tests to assert call shape / inject failures. */
  fetchFn?: typeof fetch;
  /** Logger surface — accepts info + error severity for hook telemetry. */
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function defaultReadUrl(): string | undefined {
  const value = process.env.OPENCLAW_PRE_ROUTER_URL;
  return value && value.trim() ? value.trim() : undefined;
}

function defaultReadTimeoutMs(): number {
  const raw = process.env.OPENCLAW_PRE_ROUTER_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_PRE_ROUTER_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PRE_ROUTER_TIMEOUT_MS;
  }
  // Cap at 10s to avoid pathological misconfiguration starving the
  // LLM path. The default is 2s; we accept overrides but bound them.
  return Math.min(parsed, 10_000);
}

function isPreRouterResponseShape(value: unknown): value is PreRouterResponse {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.matched !== "boolean") {
    return false;
  }
  if (obj.matched && typeof obj.response !== "string") {
    return false;
  }
  return true;
}

/**
 * Consult the pre-router service.
 *
 * Returns:
 *   - the matched response string on a clean hit (caller posts it
 *     to Slack + skips LLM dispatch);
 *   - ``null`` on any other outcome (env unset, miss, error, timeout,
 *     malformed response) — caller proceeds with normal LLM dispatch.
 *
 * Never throws. ANY exception inside the hook is caught and turned
 * into a null result so the bot stays alive.
 *
 * @example
 *   const hit = await runPreRouterHook({
 *     prompt: "show me last week's brief",
 *     channel: "C012345",
 *     user: "U012345",
 *     ts: "1717423420.000100",
 *   });
 *   if (hit !== null) {
 *     await sendMessageSlack(target, hit, sendOpts);
 *     return; // skip LLM
 *   }
 */
export async function runPreRouterHook(
  payload: PreRouterRequest,
  deps: PreRouterDeps = {},
): Promise<string | null> {
  const readUrl = deps.readUrl ?? defaultReadUrl;
  const readTimeoutMs = deps.readTimeoutMs ?? defaultReadTimeoutMs;
  const fetchFn = deps.fetchFn ?? fetch;

  const url = readUrl();
  if (!url) {
    // Hook is off — default behavior. No log; runs on every message.
    return null;
  }

  const timeoutMs = readTimeoutMs();
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError on timeout, network errors, DNS, etc. All treated as
    // "no hit", fall through to LLM. Log so operators can see if the
    // pre-router service is dead.
    const reason = err instanceof Error ? err.message : String(err);
    deps.error?.(`slack pre-router hook fetch failed (${reason}); falling through to LLM`);
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    deps.error?.(`slack pre-router hook returned HTTP ${response.status}; falling through to LLM`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.error?.(
      `slack pre-router hook returned non-JSON body (${reason}); falling through to LLM`,
    );
    return null;
  }

  if (!isPreRouterResponseShape(parsed)) {
    deps.error?.("slack pre-router hook returned malformed body; falling through to LLM");
    return null;
  }

  if (!parsed.matched) {
    deps.log?.("slack pre-router hook: miss; falling through to LLM");
    return null;
  }

  // We confirmed matched=true + response is a string in isPreRouterResponseShape.
  const text = parsed.response ?? "";
  if (!text) {
    deps.error?.(
      "slack pre-router hook returned matched=true but empty response; falling through to LLM",
    );
    return null;
  }

  deps.log?.(
    `slack pre-router hook: hit pattern=${parsed.pattern_id ?? "-"} latency_ms=${parsed.latency_ms ?? "-"}`,
  );
  return text;
}

/**
 * Public for tests and integration fixtures — lets callers inspect
 * the default timeout without re-implementing the parse.
 */
export const PRE_ROUTER_DEFAULT_TIMEOUT_MS = DEFAULT_PRE_ROUTER_TIMEOUT_MS;
