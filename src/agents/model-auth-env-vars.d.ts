import type { ProviderEnvVarLookupParams } from "../secrets/provider-env-vars.js";
export declare function resolveProviderEnvApiKeyCandidates(params?: ProviderEnvVarLookupParams): Record<string, readonly string[]>;
export declare const PROVIDER_ENV_API_KEY_CANDIDATES: Record<string, readonly string[]>;
export declare function listKnownProviderEnvApiKeyNames(): string[];
