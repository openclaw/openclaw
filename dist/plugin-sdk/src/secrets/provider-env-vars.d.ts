import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ProviderEnvVarLookupParams = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
};
export type ProviderAuthEvidence = {
    type: "local-file-with-env";
    fileEnvVar?: string;
    fallbackPaths?: readonly string[];
    requiresAnyEnv?: readonly string[];
    requiresAllEnv?: readonly string[];
    credentialMarker: string;
    source?: string;
};
export declare function resolveProviderAuthEnvVarCandidates(params?: ProviderEnvVarLookupParams): Record<string, readonly string[]>;
export declare function resolveProviderAuthEvidence(params?: ProviderEnvVarLookupParams): Record<string, readonly ProviderAuthEvidence[]>;
export declare function resolveProviderEnvVars(params?: ProviderEnvVarLookupParams): Record<string, readonly string[]>;
/**
 * Provider auth env candidates used by generic auth resolution.
 *
 * Order matters: the first non-empty value wins for helpers such as
 * `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
 * metadata so auth probes do not need to load plugin runtime.
 */
export declare const PROVIDER_AUTH_ENV_VAR_CANDIDATES: Record<string, readonly string[]>;
/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
export declare const PROVIDER_ENV_VARS: Record<string, readonly string[]>;
export declare const __testing: {
    resetProviderEnvVarCachesForTests(): void;
};
export declare function getProviderEnvVars(providerId: string, params?: ProviderEnvVarLookupParams): string[];
export declare function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[];
export declare function listKnownSecretEnvVarNames(params?: ProviderEnvVarLookupParams): string[];
export declare function omitEnvKeysCaseInsensitive(baseEnv: NodeJS.ProcessEnv, keys: Iterable<string>): NodeJS.ProcessEnv;
