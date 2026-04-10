import type { SecretRefSource } from "../config/types.secrets.js";
import { listKnownProviderEnvApiKeyNames } from "./model-auth-env-vars.js";

export const MINIMAX_OAUTH_MARKER = "minimax-oauth";
export const OAUTH_API_KEY_MARKER_PREFIX = "oauth:";
export const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
export const CUSTOM_LOCAL_AUTH_MARKER = "custom-local";
export const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
export const NON_ENV_SECRETREF_MARKER = "secretref-managed"; // pragma: allowlist secret
export const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:"; // pragma: allowlist secret

const AWS_SDK_ENV_MARKERS = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
]);

// Legacy marker names kept for backward compatibility with existing models.json files.
const LEGACY_ENV_API_KEY_MARKERS = [
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "PERPLEXITY_API_KEY",
  "FIREWORKS_API_KEY",
  "NOVITA_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
];

function listKnownEnvApiKeyMarkers(): Set<string> {
  return new Set([
    ...listKnownProviderEnvApiKeyNames(),
    ...LEGACY_ENV_API_KEY_MARKERS,
    ...AWS_SDK_ENV_MARKERS,
  ]);
}

export function isAwsSdkAuthMarker(value: string): boolean {
  return AWS_SDK_ENV_MARKERS.has(value.trim());
}

export function isKnownEnvApiKeyMarker(value: string): boolean {
  const trimmed = value.trim();
  return listKnownEnvApiKeyMarkers().has(trimmed) && !isAwsSdkAuthMarker(trimmed);
}

export function resolveOAuthApiKeyMarker(providerId: string): string {
  return `${OAUTH_API_KEY_MARKER_PREFIX}${providerId.trim()}`;
}

export function isOAuthApiKeyMarker(value: string): boolean {
  return value.trim().startsWith(OAUTH_API_KEY_MARKER_PREFIX);
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
    isOAuthApiKeyMarker(trimmed) ||
    trimmed === OLLAMA_LOCAL_AUTH_MARKER ||
    trimmed === CUSTOM_LOCAL_AUTH_MARKER ||
    trimmed === GCP_VERTEX_CREDENTIALS_MARKER ||
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
  return listKnownEnvApiKeyMarkers().has(trimmed);
}
