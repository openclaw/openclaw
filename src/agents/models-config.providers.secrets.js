import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import { isNonSecretApiKeyMarker, resolveNonEnvSecretRefApiKeyMarker, } from "./model-auth-markers.js";
import { listAuthProfilesForProvider, resolveApiKeyFromCredential, resolveApiKeyFromProfiles, resolveEnvApiKeyVarName, toDiscoveryApiKey, } from "./models-config.providers.secret-helpers.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
export { listAuthProfilesForProvider, normalizeApiKeyConfig, normalizeConfiguredProviderApiKey, normalizeHeaderValues, normalizeResolvedEnvApiKey, resolveApiKeyFromCredential, resolveApiKeyFromProfiles, resolveAwsSdkApiKeyVarName, resolveEnvApiKeyVarName, resolveMissingProviderApiKey, toDiscoveryApiKey, } from "./models-config.providers.secret-helpers.js";
function resolveAuthProfileStoreInput(input) {
    return typeof input === "function" ? input() : input;
}
export function createProviderApiKeyResolver(env, authStoreInput, config) {
    return (provider) => {
        const authProvider = resolveProviderIdForAuth(provider, { config, env });
        const envVar = resolveEnvApiKeyVarName(authProvider, env);
        if (envVar) {
            return {
                apiKey: envVar,
                discoveryApiKey: toDiscoveryApiKey(env[envVar]),
            };
        }
        const fromConfig = resolveConfigBackedProviderAuth({
            provider: authProvider,
            config,
        });
        if (fromConfig?.apiKey) {
            return {
                apiKey: fromConfig.apiKey,
                discoveryApiKey: fromConfig.discoveryApiKey,
            };
        }
        const fromProfiles = resolveApiKeyFromProfiles({
            provider: authProvider,
            store: resolveAuthProfileStoreInput(authStoreInput),
            env,
        });
        return fromProfiles?.apiKey
            ? {
                apiKey: fromProfiles.apiKey,
                discoveryApiKey: fromProfiles.discoveryApiKey,
            }
            : { apiKey: undefined, discoveryApiKey: undefined };
    };
}
export function createProviderAuthResolver(env, authStoreInput, config) {
    return (provider, options) => {
        const authProvider = resolveProviderIdForAuth(provider, { config, env });
        const authStore = resolveAuthProfileStoreInput(authStoreInput);
        const ids = listAuthProfilesForProvider(authStore, authProvider);
        let oauthCandidate;
        for (const id of ids) {
            const cred = authStore.profiles[id];
            if (!cred) {
                continue;
            }
            if (cred.type === "oauth") {
                oauthCandidate ??= {
                    apiKey: options?.oauthMarker,
                    discoveryApiKey: toDiscoveryApiKey(cred.access),
                    mode: "oauth",
                    source: "profile",
                    profileId: id,
                };
                continue;
            }
            const resolved = resolveApiKeyFromCredential(cred, env);
            if (!resolved) {
                continue;
            }
            return {
                apiKey: resolved.apiKey,
                discoveryApiKey: resolved.discoveryApiKey,
                mode: cred.type,
                source: "profile",
                profileId: id,
            };
        }
        if (oauthCandidate) {
            return oauthCandidate;
        }
        const envVar = resolveEnvApiKeyVarName(authProvider, env);
        if (envVar) {
            return {
                apiKey: envVar,
                discoveryApiKey: toDiscoveryApiKey(env[envVar]),
                mode: "api_key",
                source: "env",
            };
        }
        const fromConfig = resolveConfigBackedProviderAuth({
            provider: authProvider,
            config,
        });
        if (fromConfig) {
            return {
                apiKey: fromConfig.apiKey,
                discoveryApiKey: fromConfig.discoveryApiKey,
                mode: fromConfig.mode,
                source: "none",
            };
        }
        return {
            apiKey: undefined,
            discoveryApiKey: undefined,
            mode: "none",
            source: "none",
        };
    };
}
function resolveConfigBackedProviderAuth(params) {
    const authProvider = resolveProviderIdForAuth(params.provider, { config: params.config });
    const synthetic = resolveProviderSyntheticAuthWithPlugin({
        provider: authProvider,
        config: params.config,
        context: {
            config: params.config,
            provider: authProvider,
            providerConfig: params.config?.models?.providers?.[authProvider],
        },
    });
    const apiKey = synthetic?.apiKey?.trim();
    if (!apiKey) {
        return undefined;
    }
    return isNonSecretApiKeyMarker(apiKey)
        ? {
            apiKey,
            discoveryApiKey: toDiscoveryApiKey(apiKey),
            mode: "api_key",
            source: "config",
        }
        : {
            apiKey: resolveNonEnvSecretRefApiKeyMarker("file"),
            discoveryApiKey: toDiscoveryApiKey(apiKey),
            mode: "api_key",
            source: "config",
        };
}
