import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEnvVarCandidates,
} from "../secrets/provider-env-vars.js";
import type { ProviderEnvVarLookupParams } from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
