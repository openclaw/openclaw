import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export function isOpenAIApiBaseUrl(baseUrl?: string): boolean {
  const trimmed = normalizeOptionalString(baseUrl);
  if (!trimmed) {
    return false;
  }
  return /^https?:\/\/api\.openai\.com(?:\/v1)?\/?$/i.test(trimmed);
}

export function isOpenAICodexBaseUrl(baseUrl?: string): boolean {
  const trimmed = normalizeOptionalString(baseUrl);
  if (!trimmed) {
    return false;
  }
  // Match both the canonical `https://chatgpt.com/backend-api` and the legacy
  // `https://chatgpt.com/backend-api/v1` form that older releases persisted in
  // agent-scoped models.json. The Codex responses endpoint lives at
  // `/backend-api/codex/responses`; the `/v1` variant triggers a Cloudflare 403.
  // Treating both as "codex base URL" lets normalizeCodexTransport rewrite the
  // stale value back to the canonical root on the next resolve.
  return /^https?:\/\/chatgpt\.com\/backend-api(?:\/v1)?\/?$/i.test(trimmed);
}
