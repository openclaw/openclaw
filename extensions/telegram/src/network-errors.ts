import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const TELEGRAM_NETWORK_ORIGIN = Symbol("openclaw.telegram.network-origin");

const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

/**
 * Error codes that are safe to retry for non-idempotent send operations (e.g. sendMessage).
 *
 * These represent failures that occur *before* the request reaches Telegram's servers,
 * meaning the message was definitely not delivered and it is safe to retry.
 *
 * Contrast with RECOVERABLE_ERROR_CODES which includes codes like ECONNRESET and ETIMEDOUT
 * that can fire *after* Telegram has already received and delivered a message — retrying
 * those would cause duplicate messages.
 */
const PRE_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED", // Server actively refused the connection (never reached Telegram)
  "ENOTFOUND", // DNS resolution failed (never sent)
  "EAI_AGAIN", // Transient DNS failure (never sent)
  "ENETUNREACH", // No route to host (never sent)
  "EHOSTUNREACH", // Host unreachable (never sent)
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE =
  /^network request(?:\s+for\s+["']?[^"']+["']?)?\s+failed\s+after\b.*[!.]?$/i;

const RECOVERABLE_MESSAGE_SNIPPETS = [
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
  "timeout", // catch timeout messages not covered by error codes/names
  "timed out", // grammY getUpdates returns "timed out after X seconds" (not matched by "timeout")
];

function collectTelegramErrorCandidates(err: unknown) {
  return collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [current.cause, current.reason];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    if (readErrorName(current) === "HttpError") {
      nested.push(current.error);
    }
    return nested;
  });
}

function normalizeCode(code?: string): string {
  return code?.trim().toUpperCase() ?? "";
}

function getErrorCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") {
    return errno;
  }
  if (typeof errno === "number") {
    return String(errno);
  }
  return undefined;
}

export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";
export type TelegramNetworkErrorOrigin = {
  method?: string | null;
  url?: string | null;
};

function normalizeTelegramNetworkMethod(method?: string | null): string | null {
  const trimmed = method?.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(trimmed);
}

export function tagTelegramNetworkError(err: unknown, origin: TelegramNetworkErrorOrigin): void {
  if (!err || typeof err !== "object") {
    return;
  }
  Object.defineProperty(err, TELEGRAM_NETWORK_ORIGIN, {
    value: {
      method: normalizeTelegramNetworkMethod(origin.method),
      url: typeof origin.url === "string" && origin.url.trim() ? origin.url : null,
    } satisfies TelegramNetworkErrorOrigin,
    configurable: true,
  });
}

export function getTelegramNetworkErrorOrigin(err: unknown): TelegramNetworkErrorOrigin | null {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const origin = (candidate as Record<PropertyKey, unknown>)[TELEGRAM_NETWORK_ORIGIN];
    if (!origin || typeof origin !== "object") {
      continue;
    }
    const method = "method" in origin && typeof origin.method === "string" ? origin.method : null;
    const url = "url" in origin && typeof origin.url === "string" ? origin.url : null;
    return { method, url };
  }
  return null;
}

export function isTelegramPollingNetworkError(err: unknown): boolean {
  return getTelegramNetworkErrorOrigin(err)?.method === "getupdates";
}

/**
 * Returns true if the error is safe to retry for a non-idempotent Telegram send operation
 * (e.g. sendMessage). Only matches errors that are guaranteed to have occurred *before*
 * the request reached Telegram's servers, preventing duplicate message delivery.
 *
 * Use this instead of isRecoverableTelegramNetworkError for sendMessage/sendPhoto/etc.
 * calls where a retry would create a duplicate visible message.
 */
export function isSafeToRetrySendError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && PRE_CONNECT_ERROR_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

function hasTelegramErrorCode(err: unknown, matches: (code: number) => boolean): boolean {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object" || !("error_code" in candidate)) {
      continue;
    }
    const code = (candidate as { error_code: unknown }).error_code;
    if (typeof code === "number" && matches(code)) {
      return true;
    }
  }
  return false;
}

function hasTelegramRetryAfter(err: unknown): boolean {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const retryAfter =
      "parameters" in candidate && candidate.parameters && typeof candidate.parameters === "object"
        ? (candidate.parameters as { retry_after?: unknown }).retry_after
        : "response" in candidate &&
            candidate.response &&
            typeof candidate.response === "object" &&
            "parameters" in candidate.response
          ? (
              candidate.response as {
                parameters?: { retry_after?: unknown };
              }
            ).parameters?.retry_after
          : "error" in candidate &&
              candidate.error &&
              typeof candidate.error === "object" &&
              "parameters" in candidate.error
            ? (candidate.error as { parameters?: { retry_after?: unknown } }).parameters
                ?.retry_after
            : undefined;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      return true;
    }
  }
  return false;
}

/** Returns true for HTTP 5xx server errors (error may have been processed). */
export function isTelegramServerError(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code >= 500);
}

export function isTelegramRateLimitError(err: unknown): boolean {
  return (
    hasTelegramErrorCode(err, (code) => code === 429) ||
    (hasTelegramRetryAfter(err) && /(?:^|\b)429\b|too many requests/i.test(formatErrorMessage(err)))
  );
}

/** Returns true for HTTP 4xx client errors (Telegram explicitly rejected, not applied). */
export function isTelegramClientRejection(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code >= 400 && code < 500);
}

/**
 * Error codes that indicate a broken/stale *existing* TCP connection rather than
 * a failure to establish a new connection.
 *
 * Excludes connect-time codes (ENOTFOUND, ECONNREFUSED, EAI_AGAIN, ENETUNREACH,
 * EHOSTUNREACH) because those only mean the health-check probe could not open a
 * new connection -- the current long-poll socket may still be healthy.
 */
const STALE_CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET", // Existing connection reset by peer
  "EPIPE", // Write to a broken pipe/socket
  "ETIMEDOUT", // Existing connection timed out
  "ESOCKETTIMEDOUT", // Socket-level timeout on existing connection
  "UND_ERR_HEADERS_TIMEOUT", // Undici headers timeout on existing connection
  "UND_ERR_BODY_TIMEOUT", // Undici body timeout on existing connection
  "UND_ERR_SOCKET", // Undici socket error on existing connection
  "UND_ERR_ABORTED", // Undici aborted (e.g. socket closed mid-stream)
  "ECONNABORTED", // Connection aborted
  "ERR_NETWORK", // Generic network failure
  // UND_ERR_CONNECT_TIMEOUT excluded: indicates a TCP connect-phase timeout in the
  // health-check probe, not a broken existing long-poll socket.
]);

/**
 * Error names that indicate stale/broken connections (not connect-time failures).
 *
 * AbortError is intentionally excluded: polling-session aborts in-flight fetches
 * itself via fetchAbortController.abort() during stall recovery and forced
 * restarts, so treating self-induced AbortError on a pending health-check getMe
 * as a stale-connection signal would misclassify our own teardown path.
 */
const STALE_CONNECTION_ERROR_NAMES = new Set([
  "TimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  // ConnectTimeoutError excluded: could mean the probe failed to connect,
  // not that the existing polling socket is stale.
]);

/**
 * Error codes that indicate a connect-time failure rather than a broken existing
 * socket. If any candidate in the error graph carries one of these, the failure
 * is treated as "could not open a new connection" and NOT classified as a stale
 * existing connection. This lets broad wrappers like TypeError("fetch failed")
 * with nested cause.code=ENOTFOUND / ECONNREFUSED fall through without forcing
 * a polling restart.
 */
const CONNECT_TIME_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Connection-level message snippets for stale-connection detection.
 * Intentionally excludes the broad "timeout" / "timed out" snippets from
 * RECOVERABLE_MESSAGE_SNIPPETS because those match HTTP timeout responses
 * (e.g. 504 Gateway Timeout) where the server actually responded.
 * Also excludes "getaddrinfo" since DNS failures are connect-time errors.
 */
const STALE_CONNECTION_MESSAGE_SNIPPETS = [
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "health check timeout",
];

/**
 * Returns true when the error indicates a dead or stale TCP connection rather than
 * a Telegram API-level HTTP error response or a connect-time failure.
 *
 * Key distinction 1: an HTTP 504 Gateway Timeout (or any other HTTP status error) means
 * the server actually responded -- the underlying TCP link is alive and the health-check
 * watchdog should NOT treat it as a stale socket.  Only connection-level failures
 * (ECONNRESET, ETIMEDOUT, socket hang up, fetch failed, our own "Health check timeout",
 * etc.) indicate that the TCP connection itself is dead or unusable.
 *
 * Key distinction 2: connect-time failures (ENOTFOUND, ECONNREFUSED, EAI_AGAIN) only
 * mean the health-check probe could not open a *new* connection.  The existing
 * long-poll socket may still be healthy, so these should NOT trigger a restart.
 *
 * Used by the health-check watchdog so it does not force-restart polling sessions
 * during transient Telegram-side outages or DNS blips.
 */
export function isStaleConnectionError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  // If the error carries a Telegram HTTP error_code, the server responded --
  // the connection is alive regardless of the status code (429, 5xx, etc.).
  if (hasTelegramErrorCode(err, () => true)) {
    return false;
  }

  // Pre-scan for connect-time codes anywhere in the error graph. A broad
  // wrapper like TypeError("fetch failed") whose `cause.code` is ENOTFOUND /
  // ECONNREFUSED / EAI_AGAIN is a probe-side failure to open a new connection,
  // not evidence that the existing long-poll socket is dead. We must check
  // this before the outer message matches "fetch failed" / "network request".
  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && CONNECT_TIME_ERROR_CODES.has(code)) {
      return false;
    }
  }

  for (const candidate of collectTelegramErrorCandidates(err)) {
    // Skip candidates that are themselves Telegram HTTP error objects
    if (
      candidate &&
      typeof candidate === "object" &&
      "error_code" in candidate &&
      typeof (candidate as { error_code: unknown }).error_code === "number"
    ) {
      continue;
    }

    const code = normalizeCode(getErrorCode(candidate));
    if (code && STALE_CONNECTION_ERROR_CODES.has(code)) {
      return true;
    }

    const name = readErrorName(candidate);
    if (name && STALE_CONNECTION_ERROR_NAMES.has(name)) {
      return true;
    }

    const message = formatErrorMessage(candidate).trim().toLowerCase();
    if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) {
      return true;
    }
    if (message && STALE_CONNECTION_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
      return true;
    }
  }

  return false;
}

export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) {
    return false;
  }
  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) {
      return true;
    }

    const name = readErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return true;
    }

    const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(candidate));
    if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) {
      return true;
    }
    if (message && GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE.test(message)) {
      return true;
    }
    if (allowMessageMatch && message) {
      if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}
