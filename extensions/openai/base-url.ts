import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Resolve the default OpenAI base URL for the dynamic-model registry.
 * Honors OPENAI_BASE_URL when no provider config sets a baseUrl, mirroring
 * the OpenAI Node SDK's own env-var precedence so users running OpenClaw
 * behind an OpenAI-compatible proxy (LiteLLM, vLLM, AEP, etc.) only need to
 * set the env var instead of duplicating it in models.providers.openai.baseUrl.
 *
 * Provider-config baseUrl still wins over the env var because the resolver
 * (src/agents/pi-embedded-runner/model.ts) prefers providerConfig.baseUrl
 * before consulting discoveredModel.baseUrl.
 */
export function resolveOpenAIDefaultBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeOptionalString(env.OPENAI_BASE_URL) ?? OPENAI_DEFAULT_BASE_URL;
}

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
  return /^https?:\/\/chatgpt\.com\/backend-api(?:\/codex)?(?:\/v1)?\/?$/i.test(trimmed);
}

export function canonicalizeCodexResponsesBaseUrl(baseUrl?: string): string | undefined {
  return isOpenAICodexBaseUrl(baseUrl) ? OPENAI_CODEX_RESPONSES_BASE_URL : baseUrl;
}
