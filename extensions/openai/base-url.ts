import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OPENAI_CODEX_BASE_URL } from "./openai-codex-catalog.js";

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

// Returns the canonical Codex Responses URL when input is a recognized
// Codex base URL (with or without the /codex segment). Other inputs pass
// through unchanged so non-Codex configurations are preserved. OpenAI
// retired the /backend-api/responses alias server-side on 2026-04, so any
// recognized Codex variant must resolve to /backend-api/codex.
export function canonicalizeCodexResponsesBaseUrl(baseUrl?: string): string | undefined {
  if (!isOpenAICodexBaseUrl(baseUrl)) {
    return baseUrl;
  }
  return OPENAI_CODEX_BASE_URL;
}
