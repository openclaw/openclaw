import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEvidence,
  resolveProviderAuthEnvVarCandidates,
} from "../secrets/provider-env-vars.js";
import type {
  ProviderAuthEvidence,
  ProviderEnvVarLookupParams,
} from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

export function resolveProviderEnvAuthEvidence(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly ProviderAuthEvidence[]> {
  return resolveProviderAuthEvidence(params);
}

export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
