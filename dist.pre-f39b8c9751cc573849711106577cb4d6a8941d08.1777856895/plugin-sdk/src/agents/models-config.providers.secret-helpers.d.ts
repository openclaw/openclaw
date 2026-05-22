import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
export type SecretDefaults = {
    env?: string;
    file?: string;
    exec?: string;
};
export type ProfileApiKeyResolution = {
    apiKey: string;
    source: "plaintext" | "env-ref" | "non-env-ref";
    discoveryApiKey?: string;
};
export type ProviderApiKeyResolver = (provider: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
};
export type ProviderAuthResolver = (provider: string, options?: {
    oauthMarker?: string;
}) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
};
export declare function normalizeApiKeyConfig(value: string): string;
export declare function toDiscoveryApiKey(value: string | undefined): string | undefined;
export declare function resolveEnvApiKeyVarName(provider: string, env?: NodeJS.ProcessEnv): string | undefined;
export declare function resolveAwsSdkApiKeyVarName(env?: NodeJS.ProcessEnv): string | undefined;
export declare function normalizeHeaderValues(params: {
    headers: ProviderConfig["headers"] | undefined;
    secretDefaults: SecretDefaults | undefined;
}): {
    headers: ProviderConfig["headers"] | undefined;
    mutated: boolean;
};
export declare function resolveApiKeyFromCredential(cred: AuthProfileStore["profiles"][string] | undefined, env?: NodeJS.ProcessEnv): ProfileApiKeyResolution | undefined;
export declare function listAuthProfilesForProvider(store: AuthProfileStore, provider: string): string[];
export declare function resolveApiKeyFromProfiles(params: {
    provider: string;
    store: AuthProfileStore;
    env?: NodeJS.ProcessEnv;
}): ProfileApiKeyResolution | undefined;
export declare function normalizeConfiguredProviderApiKey(params: {
    providerKey: string;
    provider: ProviderConfig;
    secretDefaults: SecretDefaults | undefined;
    profileApiKey: ProfileApiKeyResolution | undefined;
    secretRefManagedProviders?: Set<string>;
}): ProviderConfig;
export declare function normalizeResolvedEnvApiKey(params: {
    providerKey: string;
    provider: ProviderConfig;
    env: NodeJS.ProcessEnv;
    secretRefManagedProviders?: Set<string>;
}): ProviderConfig;
export declare function resolveMissingProviderApiKey(params: {
    providerKey: string;
    provider: ProviderConfig;
    env: NodeJS.ProcessEnv;
    profileApiKey: ProfileApiKeyResolution | undefined;
    secretRefManagedProviders?: Set<string>;
    providerApiKeyResolver?: (env: NodeJS.ProcessEnv) => string | undefined;
}): ProviderConfig;
export {};
