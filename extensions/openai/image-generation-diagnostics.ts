// Log and error text helpers for the OpenAI image provider.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";

const LOG_VALUE_MAX_CHARS = 256;

export function sanitizeLogValue(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const cleaned = raw
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gi, "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "unknown";
  }
  return cleaned.length > LOG_VALUE_MAX_CHARS
    ? `${truncateUtf16Safe(cleaned, LOG_VALUE_MAX_CHARS)}...`
    : cleaned;
}

// Direct Images API auth failures look like account or model problems unless the
// message names the route OpenClaw picked; an unused OAuth profile is the common cause.
export function annotateDirectImageAuthFailure(
  error: unknown,
  params: {
    url: string;
    authMode?: unknown;
    authSource?: unknown;
    // Configured headers or request auth replaced the resolved credential before sending.
    authOverridden: boolean;
    oauthAvailable: boolean;
  },
): void {
  if (
    !(error instanceof Error) ||
    !("status" in error) ||
    (error.status !== 401 && error.status !== 403)
  ) {
    return;
  }
  // Query strings can carry tokens on proxied endpoints, so only origin and path are shown.
  const parsedUrl = URL.parse(params.url);
  const endpoint = parsedUrl ? `${parsedUrl.origin}${parsedUrl.pathname}` : undefined;
  const credential = params.authOverridden
    ? "credential=configured-header source=models.providers.openai"
    : `credential=${sanitizeLogValue(params.authMode ?? "api-key")} source=${sanitizeLogValue(
        params.authSource,
      )}`;
  const hint = params.oauthAvailable
    ? `; a ChatGPT/Codex OAuth profile exists but explicit models.providers.openai settings select the direct Images API. To use that profile, set baseUrl "${OPENAI_CODEX_RESPONSES_BASE_URL}" and api "openai-chatgpt-responses", without apiKey, auth "api-key", or auth headers`
    : "";
  error.message = `${error.message} (route=images-api url=${sanitizeLogValue(endpoint)} ${credential}${hint})`;
}
