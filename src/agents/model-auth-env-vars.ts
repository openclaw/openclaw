import {
  listKnownProviderAuthEnvVarNames,
  PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  resolveProviderAuthEnvVarCandidates,
} from "../secrets/provider-env-vars.js";
import type { ProviderEnvVarLookupParams } from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

/**
 * Lazy-loaded provider auth env var candidates.
 *
 * Delegates to the lazy PROVIDER_AUTH_ENV_VAR_CANDIDATES proxy to ensure
 * bundled plugin manifest metadata is available when first accessed,
 * avoiding premature resolution at module import time.
 *
 * @see src/secrets/provider-env-vars.ts PROVIDER_AUTH_ENV_VAR_CANDIDATES
 */
export const PROVIDER_ENV_API_KEY_CANDIDATES: Record<string, readonly string[]> =
  PROVIDER_AUTH_ENV_VAR_CANDIDATES;

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
