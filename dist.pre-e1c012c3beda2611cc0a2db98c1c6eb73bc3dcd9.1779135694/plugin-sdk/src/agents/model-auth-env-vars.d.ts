import type { ProviderAuthEvidence, ProviderEnvVarLookupParams } from "../secrets/provider-env-vars.js";
export declare function resolveProviderEnvApiKeyCandidates(params?: ProviderEnvVarLookupParams): Record<string, readonly string[]>;
export declare function resolveProviderEnvAuthEvidence(params?: ProviderEnvVarLookupParams): Record<string, readonly ProviderAuthEvidence[]>;
export declare function listProviderEnvAuthLookupKeys(params: {
    envCandidateMap: Readonly<Record<string, readonly string[]>>;
    authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
}): string[];
export declare function resolveProviderEnvAuthLookupKeys(params?: ProviderEnvVarLookupParams): string[];
export declare const PROVIDER_ENV_API_KEY_CANDIDATES: Record<string, readonly string[]>;
export declare function listKnownProviderEnvApiKeyNames(): string[];
