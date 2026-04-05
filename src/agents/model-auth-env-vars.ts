import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEnvVarCandidates,
} from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates();
}

export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
