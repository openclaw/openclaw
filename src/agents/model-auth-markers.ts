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
  return opts?.includeEnvVarName === false ? false : isEnvVarNameMarker(trimmed);
}
