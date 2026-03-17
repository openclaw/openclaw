import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName
} from "../../../src/infra/errors.js";
const TELEGRAM_NETWORK_ORIGIN = /* @__PURE__ */ Symbol("openclaw.telegram.network-origin");
const RECOVERABLE_ERROR_CODES = /* @__PURE__ */ new Set([
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
  "ERR_NETWORK"
]);
const PRE_CONNECT_ERROR_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  // Server actively refused the connection (never reached Telegram)
  "ENOTFOUND",
  // DNS resolution failed (never sent)
  "EAI_AGAIN",
  // Transient DNS failure (never sent)
  "ENETUNREACH",
  // No route to host (never sent)
  "EHOSTUNREACH"
  // Host unreachable (never sent)
]);
const RECOVERABLE_ERROR_NAMES = /* @__PURE__ */ new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError"
]);
const ALWAYS_RECOVERABLE_MESSAGES = /* @__PURE__ */ new Set(["fetch failed", "typeerror: fetch failed"]);
const GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE = /^network request(?:\s+for\s+["']?[^"']+["']?)?\s+failed\s+after\b.*[!.]?$/i;
const RECOVERABLE_MESSAGE_SNIPPETS = [
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
  "timeout",
  // catch timeout messages not covered by error codes/names
  "timed out"
  // grammY getUpdates returns "timed out after X seconds" (not matched by "timeout")
];
function collectTelegramErrorCandidates(err) {
  return collectErrorGraphCandidates(err, (current) => {
    const nested = [current.cause, current.reason];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    if (readErrorName(current) === "HttpError") {
      nested.push(current.error);
    }
    return nested;
  });
}
function normalizeCode(code) {
  return code?.trim().toUpperCase() ?? "";
}
function getErrorCode(err) {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return void 0;
  }
  const errno = err.errno;
  if (typeof errno === "string") {
    return errno;
  }
  if (typeof errno === "number") {
    return String(errno);
  }
  return void 0;
}
function normalizeTelegramNetworkMethod(method) {
  const trimmed = method?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}
function tagTelegramNetworkError(err, origin) {
  if (!err || typeof err !== "object") {
    return;
  }
  Object.defineProperty(err, TELEGRAM_NETWORK_ORIGIN, {
    value: {
      method: normalizeTelegramNetworkMethod(origin.method),
      url: typeof origin.url === "string" && origin.url.trim() ? origin.url : null
    },
    configurable: true
  });
}
function getTelegramNetworkErrorOrigin(err) {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const origin = candidate[TELEGRAM_NETWORK_ORIGIN];
    if (!origin || typeof origin !== "object") {
      continue;
    }
    const method = "method" in origin && typeof origin.method === "string" ? origin.method : null;
    const url = "url" in origin && typeof origin.url === "string" ? origin.url : null;
    return { method, url };
  }
  return null;
}
function isTelegramPollingNetworkError(err) {
  return getTelegramNetworkErrorOrigin(err)?.method === "getupdates";
}
function isSafeToRetrySendError(err) {
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
function hasTelegramErrorCode(err, matches) {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object" || !("error_code" in candidate)) {
      continue;
    }
    const code = candidate.error_code;
    if (typeof code === "number" && matches(code)) {
      return true;
    }
  }
  return false;
}
function isTelegramServerError(err) {
  return hasTelegramErrorCode(err, (code) => code >= 500);
}
function isTelegramClientRejection(err) {
  return hasTelegramErrorCode(err, (code) => code >= 400 && code < 500);
}
function isRecoverableTelegramNetworkError(err, options = {}) {
  if (!err) {
    return false;
  }
  const allowMessageMatch = typeof options.allowMessageMatch === "boolean" ? options.allowMessageMatch : options.context !== "send";
  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) {
      return true;
    }
    const name = readErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return true;
    }
    const message = formatErrorMessage(candidate).trim().toLowerCase();
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
export {
  getTelegramNetworkErrorOrigin,
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramPollingNetworkError,
  isTelegramServerError,
  tagTelegramNetworkError
};
