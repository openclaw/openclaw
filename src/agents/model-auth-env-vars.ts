import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEvidence,
  resolveProviderAuthEnvVarCandidates,
  resolveProviderAuthLookupMaps,
} from "../secrets/provider-env-vars.js";
import type {
  ProviderAuthEvidence,
  ProviderAuthLookupMaps,
  ProviderEnvVarLookupParams,
} from "../secrets/provider-env-vars.js";

/** Returns provider-to-env-var candidates used when resolving API-key auth from process env. */
export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

/** Returns provider auth evidence from env/config so status surfaces can explain how auth was found. */
export function resolveProviderEnvAuthEvidence(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly ProviderAuthEvidence[]> {
  return resolveProviderAuthEvidence(params);
}

/** Returns lookup maps for provider env aliases and auth evidence in one reusable snapshot. */
export function resolveProviderEnvAuthLookupMaps(
  params?: ProviderEnvVarLookupParams,
): ProviderAuthLookupMaps {
  return resolveProviderAuthLookupMaps(params);
}

/** Combines env candidate and auth evidence provider keys into sorted display order. */
export function listProviderEnvAuthLookupKeys(params: {
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
}): string[] {
  return Array.from(
    new Set([...Object.keys(params.envCandidateMap), ...Object.keys(params.authEvidenceMap)]),
  ).toSorted((a, b) => a.localeCompare(b));
}

/** Resolves the provider ids that have env-auth lookup data for model/auth status displays. */
export function resolveProviderEnvAuthLookupKeys(params?: ProviderEnvVarLookupParams): string[] {
  const lookupMaps = resolveProviderEnvAuthLookupMaps(params);
  return listProviderEnvAuthLookupKeys({
    envCandidateMap: lookupMaps.envCandidateMap,
    authEvidenceMap: lookupMaps.authEvidenceMap,
  });
}

/** Lists all known API-key env var names across built-in and contributed provider metadata. */
export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
