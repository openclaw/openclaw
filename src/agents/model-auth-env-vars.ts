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

export function resolveProviderEnvAuthLookupKeys(params?: ProviderEnvVarLookupParams): string[] {
  const envCandidateMap = resolveProviderEnvApiKeyCandidates(params);
  const authEvidenceMap = resolveProviderEnvAuthEvidence(params);
  return Array.from(
    new Set([...Object.keys(envCandidateMap), ...Object.keys(authEvidenceMap)]),
  ).toSorted((a, b) => a.localeCompare(b));
}

export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
