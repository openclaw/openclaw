import type { SecretRefSource } from "../config/types.secrets.js";

export const NON_ENV_SECRETREF_MARKER = "secretref-managed"; // pragma: allowlist secret
export const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:"; // pragma: allowlist secret

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
