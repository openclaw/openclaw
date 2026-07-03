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
const URL_QUERY_FALLBACK_QUOTES = new Set(['"', "'", "`"]);
const URL_QUERY_FALLBACK_KEY_STOPS = new Set([
  "=",
  "&",
  "#",
  " ",
  "\t",
  "\r",
  "\n",
  '"',
  "'",
  "`",
  "<",
  ">",
  ")",
  "]",
]);
const URL_QUERY_FALLBACK_UNQUOTED_VALUE_STOPS = new Set([
  "&",
  "#",
  " ",
  "\t",
  "\r",
  "\n",
  '"',
  "'",
  "`",
  "<",
  ">",
]);
const URL_QUERY_FALLBACK_WRAPPER_CLOSES = new Set([")", "]"]);
const URL_QUERY_FALLBACK_AFTER_WRAPPER_STOPS = new Set([" ", "\t", "\r", "\n", ",", ";", ".", ":"]);

// Telegram Bot API credentials live in `/bot<token>/...` path segments rather
// than userinfo or query params. Keep this shape aligned with logging/redact.ts.
const TELEGRAM_BOT_TOKEN_PATH_RE = /\/bot\d{6,}(?::|%3[aA])[A-Za-z0-9_-]{20,}(?=\/|$)/giu;

function redactSensitiveUrlPath(value: string): string {
  return value.replace(TELEGRAM_BOT_TOKEN_PATH_RE, "/bot***");
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
    const redactedPath = redactSensitiveUrlPath(parsed.pathname);
    if (redactedPath !== parsed.pathname) {
      parsed.pathname = redactedPath;
      mutated = true;
    }
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

function findFallbackQueryValueEnd(
  value: string,
  valueStart: number,
): { end: number; closingQuote?: string } {
  const quote = value[valueStart];
  if (quote && URL_QUERY_FALLBACK_QUOTES.has(quote)) {
    const quotedValueStart = valueStart + 1;
    const closingQuoteIndex = value.indexOf(quote, quotedValueStart);
    if (closingQuoteIndex !== -1) {
      const afterQuote = value[closingQuoteIndex + 1];
      if (afterQuote === undefined || URL_QUERY_FALLBACK_UNQUOTED_VALUE_STOPS.has(afterQuote)) {
        return { end: closingQuoteIndex, closingQuote: quote };
      }
    }
    return { end: findFallbackUnquotedQueryValueEnd(value, quotedValueStart) };
  }
  return { end: findFallbackUnquotedQueryValueEnd(value, valueStart) };
}

function findFallbackUnquotedQueryValueEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && !isFallbackUnquotedQueryValueStop(value, end)) {
    end += 1;
  }
  return end;
}

function isFallbackUnquotedQueryValueStop(value: string, index: number): boolean {
  const char = value[index];
  if (URL_QUERY_FALLBACK_UNQUOTED_VALUE_STOPS.has(char)) {
    return true;
  }
  if (!URL_QUERY_FALLBACK_WRAPPER_CLOSES.has(char)) {
    return false;
  }
  const next = value[index + 1];
  if (next === undefined || !URL_QUERY_FALLBACK_AFTER_WRAPPER_STOPS.has(next)) {
    return false;
  }
  return !hasFallbackQuerySeparatorAfterWrapperClose(value, index + 1);
}

function hasFallbackQuerySeparatorAfterWrapperClose(value: string, start: number): boolean {
  for (let i = start; i < value.length; i += 1) {
    const char = value[i];
    if (char === "&") {
      return true;
    }
    if (
      char === "#" ||
      char === " " ||
      char === "\t" ||
      char === "\r" ||
      char === "\n" ||
      char === "<" ||
      char === ">"
    ) {
      return false;
    }
  }
  return false;
}

// This fallback scans arbitrary diagnostic text, where query-looking spans may be malformed.
function redactFallbackQuerySecrets(value: string): string {
  let redacted = "";
  let cursor = 0;
  for (let i = 0; i < value.length; i += 1) {
    const prefix = value[i];
    if (prefix !== "?" && prefix !== "&") {
      continue;
    }

    let keyEnd = i + 1;
    while (keyEnd < value.length && !URL_QUERY_FALLBACK_KEY_STOPS.has(value[keyEnd])) {
      keyEnd += 1;
    }
    if (keyEnd === i + 1 || value[keyEnd] !== "=") {
      continue;
    }

    const key = value.slice(i + 1, keyEnd);
    const valueStart = keyEnd + 1;
    const { end: valueEnd, closingQuote } = findFallbackQueryValueEnd(value, valueStart);
    if (valueEnd === valueStart) {
      continue;
    }

    if (!isSensitiveUrlQueryParamName(key)) {
      continue;
    }

    const redactedEnd = closingQuote ? valueEnd + 1 : valueEnd;
    const openingQuote = value[valueStart];
    redacted += value.slice(cursor, valueStart);
    redacted +=
      openingQuote && URL_QUERY_FALLBACK_QUOTES.has(openingQuote)
        ? `${openingQuote}***${closingQuote ?? ""}`
        : "***";
    cursor = redactedEnd;
    i = redactedEnd - 1;
  }
  return cursor === 0 ? value : redacted + value.slice(cursor);
}

/** Redacts sensitive URL-looking substrings even when the full value is not a valid URL. */
export function redactSensitiveUrlLikeString(value: string): string {
  const redactedUrl = redactSensitiveUrl(value);
  if (redactedUrl !== value) {
    return redactedUrl;
  }
  const redactedFallback = redactFallbackQuerySecrets(
    value.replace(/\/\/([^@/?#\s]+)@/g, "//***:***@"),
  );
  return redactSensitiveUrlPath(redactedFallback);
}
