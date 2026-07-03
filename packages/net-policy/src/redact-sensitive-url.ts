// Network Policy module implements redact sensitive url behavior.
type ConfigUiHintTags = {
  tags?: string[];
};

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Config UI hint tag for URL-like values that may embed credentials or tokens. */
export const SENSITIVE_URL_HINT_TAG = "url-secret";

const SENSITIVE_URL_QUERY_PARAM_NAMES = new Set([
  "token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "access_token",
  "auth_token",
  "password",
  "pass",
  "passwd",
  "auth",
  "jwt",
  "session",
  "id_token",
  "code",
  "client_secret",
  "app_secret",
  "hook_token",
  "refresh_token",
  "signature",
  "x_amz_signature",
  "x_amz_security_token",
  "private_key",
  "credential",
  "authorization",
]);
// Keep in sync with FORM_BODY_KEY_SEPARATOR_RE in src/logging/redact.ts: Hangul fillers are
// category Lo, so \p{C}\p{Z} alone would let them splice sensitive key names.
const URL_QUERY_NAME_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;

// Bot API credential path segments must be redacted even in diagnostic/log URLs.
// Require the real Telegram token shape (\u22656 digits, colon or %3A, \u226520 secret chars)
// so ordinary `/bot` application routes are not hidden.
const TELEGRAM_BOT_TOKEN_PATH_RE = /\/bot\d{6,}(?::|%3[aA])[A-Za-z0-9_-]{20,}(?=\/|$)/giu;

function redactTelegramBotTokenPath(value: string): string {
  return value.replace(TELEGRAM_BOT_TOKEN_PATH_RE, "/bot***");
}

// Universal bot token path redactors applied to every URL regardless of hostname.
// The regex is strict enough (≥6-digit id + ≥20-char secret) to avoid false positives
// on ordinary /bot application routes, so hostname-gating is unnecessary.
const UNIVERSAL_BOT_TOKEN_PATH_REDACTORS: Array<(value: string) => string> = [
  redactTelegramBotTokenPath,
];

// Registry of hostname-specific Bot API path-token redactors for future extensibility.
// A matching hostname entry runs in addition to the universal redactors above.
const BOT_TOKEN_PATH_REDACTORS: Record<string, (value: string) => string> = {};

/**
 * Redact known Bot API credential path segments from a URL string.
 * Universal redactors (Telegram bot token path) always apply.
 * When `hostname` is provided and matches a hostname-specific policy, that
 * policy also runs. When omitted, all hostname-specific policies run too.
 */
export function redactBotTokenPath(value: string, hostname?: string): string {
  let result = value;
  for (const redactor of UNIVERSAL_BOT_TOKEN_PATH_REDACTORS) {
    result = redactor(result);
  }
  if (hostname) {
    const hostRedactor = BOT_TOKEN_PATH_REDACTORS[hostname];
    if (hostRedactor) {
      result = hostRedactor(result);
    }
  } else {
    for (const redactor of Object.values(BOT_TOKEN_PATH_REDACTORS)) {
      result = redactor(result);
    }
  }
  return result;
}

function normalizeUrlQueryParamName(name: string): string {
  const stripped = name.replace(URL_QUERY_NAME_SEPARATOR_RE, "");
  try {
    return normalizeLowercaseStringOrEmpty(
      decodeURIComponent(stripped).replace(URL_QUERY_NAME_SEPARATOR_RE, ""),
    ).replaceAll("-", "_");
  } catch {
    return normalizeLowercaseStringOrEmpty(stripped).replaceAll("-", "_");
  }
}

/** True for auth-like URL query parameter names that should be redacted. */
export function isSensitiveUrlQueryParamName(name: string): boolean {
  const normalized = normalizeUrlQueryParamName(name);
  return SENSITIVE_URL_QUERY_PARAM_NAMES.has(normalized);
}

/** True for config paths whose URL values may contain credentials or secret query params. */
export function isSensitiveUrlConfigPath(path: string): boolean {
  if (path.endsWith(".baseUrl") || path.endsWith(".httpUrl")) {
    return true;
  }
  if (path.endsWith(".cdpUrl")) {
    return true;
  }
  if (path.endsWith(".request.proxy.url")) {
    return true;
  }
  return /^mcp\.servers\.(?:\*|[^.]+)\.url$/.test(path);
}

/** True when a config UI hint explicitly marks a URL-like value as secret-bearing. */
export function hasSensitiveUrlHintTag(hint: ConfigUiHintTags | undefined): boolean {
  return hint?.tags?.includes(SENSITIVE_URL_HINT_TAG) === true;
}

/** Redacts credentials and sensitive query params from parseable URLs. */
export function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value);
    let mutated = false;
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
      mutated = true;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveUrlQueryParamName(key)) {
        parsed.searchParams.set(key, "***");
        mutated = true;
      }
    }
    return mutated ? parsed.toString() : value;
  } catch {
    return value;
  }
}

/** Redacts sensitive URL-looking substrings even when the full value is not a valid URL. */
export function redactSensitiveUrlLikeString(value: string): string {
  const redactedUrl = redactSensitiveUrl(value);
  if (redactedUrl !== value) {
    return redactedUrl;
  }
  return value
    .replace(/\/\/([^@/?#\s]+)@/g, "//***:***@")
    .replace(/([?&])([^=&]+)=([^&]*)/g, (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=***` : match,
    );
}
