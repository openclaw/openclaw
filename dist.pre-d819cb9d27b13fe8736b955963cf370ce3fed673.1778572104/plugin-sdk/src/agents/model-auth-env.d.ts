import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthEvidence } from "../secrets/provider-env-vars.js";
export type EnvApiKeyResult = {
    apiKey: string;
    source: string;
};
type EnvApiKeyLookupOptions = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    aliasMap?: Readonly<Record<string, string>>;
    candidateMap?: Readonly<Record<string, readonly string[]>>;
    authEvidenceMap?: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
};
export declare function resolveEnvApiKey(provider: string, env?: NodeJS.ProcessEnv, options?: EnvApiKeyLookupOptions): EnvApiKeyResult | null;
export {};
