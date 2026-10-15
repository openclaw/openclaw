import type { ProviderAuthEvidence } from "../secrets/provider-env-vars.js";

export {
  listKnownProviderAuthEnvVarNamesCore as listKnownProviderEnvApiKeyNames,
  resolveProviderAuthLookupMaps as resolveProviderEnvAuthLookupMaps,
} from "../secrets/provider-env-vars.js";

/** Lists every provider key represented by either env candidates or auth evidence. */
export function listProviderEnvAuthLookupKeys(params: {
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
}): string[] {
  // Evidence-only providers still need status/discovery rows even when they do not expose env vars.
  return Array.from(
    new Set([...Object.keys(params.envCandidateMap), ...Object.keys(params.authEvidenceMap)]),
  ).toSorted((a, b) => a.localeCompare(b));
}
