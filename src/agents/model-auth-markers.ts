import type { SecretRefSource } from "../config/types.secrets.js";

export const MINIMAX_OAUTH_MARKER = "minimax-oauth";
export const QWEN_OAUTH_MARKER = "qwen-oauth";
export const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
export const NON_ENV_SECRETREF_MARKER = "secretref-managed";
export const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:";

const AWS_SDK_ENV_MARKERS = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
]);

const KNOWN_ENV_API_KEY_MARKERS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "NOVITA_API_KEY",
  "CEREBRAS_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "CHUTES_API_KEY",
  "CHUTES_OAUTH_TOKEN",
  "MINIMAX_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
  "QWEN_PORTAL_API_KEY",
  "QWEN_OAUTH_TOKEN",
  "VOLCANO_ENGINE_API_KEY",
  "OPENCODE_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "SYNTHETIC_API_KEY",
  "KILOCODE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  ...AWS_SDK_ENV_MARKERS,
]);

export function isEnvVarNameMarker(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value.trim());
}

export function isAwsSdkAuthMarker(value: string): boolean {
  return AWS_SDK_ENV_MARKERS.has(value.trim());
}

export function resolveNonEnvSecretRefApiKeyMarker(_source: SecretRefSource): string {
  return NON_ENV_SECRETREF_MARKER;
}

export function resolveNonEnvSecretRefHeaderValueMarker(_source: SecretRefSource): string {
  return NON_ENV_SECRETREF_MARKER;
}

export function resolveEnvSecretRefHeaderValueMarker(envVarName: string): string {
  return `${SECRETREF_ENV_HEADER_MARKER_PREFIX}${envVarName.trim()}`;
}

export function isSecretRefHeaderValueMarker(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === NON_ENV_SECRETREF_MARKER || trimmed.startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX)
  );
}

export function isNonSecretApiKeyMarker(
  value: string,
  opts?: { includeEnvVarName?: boolean },
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const isKnownMarker =
    trimmed === MINIMAX_OAUTH_MARKER ||
    trimmed === QWEN_OAUTH_MARKER ||
    trimmed === OLLAMA_LOCAL_AUTH_MARKER ||
    trimmed === NON_ENV_SECRETREF_MARKER ||
    isAwsSdkAuthMarker(trimmed);
  if (isKnownMarker) {
    return true;
  }
  if (opts?.includeEnvVarName === false) {
    return false;
  }
  // Do not treat arbitrary ALL_CAPS values as markers; only recognize the
  // known env-var markers we intentionally persist for compatibility.
  return KNOWN_ENV_API_KEY_MARKERS.has(trimmed);
}
