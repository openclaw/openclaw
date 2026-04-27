import { listKnownProviderAuthEnvVarNames, resolveProviderAuthEnvVarCandidates, } from "../secrets/provider-env-vars.js";
export function resolveProviderEnvApiKeyCandidates(params) {
    return resolveProviderAuthEnvVarCandidates(params);
}
export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();
export function listKnownProviderEnvApiKeyNames() {
    return listKnownProviderAuthEnvVarNames();
}
