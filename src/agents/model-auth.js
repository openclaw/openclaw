import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { getRuntimeConfigSnapshot } from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildProviderMissingAuthMessageWithPlugin, resolveProviderSyntheticAuthWithPlugin, shouldDeferProviderSyntheticProfileAuthWithPlugin, } from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../shared/string-coerce.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { ensureAuthProfileStore, listProfilesForProvider, resolveApiKeyForProfile, resolveAuthProfileOrder, resolveAuthStorePathForDisplay, } from "./auth-profiles.js";
import * as cliCredentials from "./cli-credentials.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import { CUSTOM_LOCAL_AUTH_MARKER, isKnownEnvApiKeyMarker, isNonSecretApiKeyMarker, NON_ENV_SECRETREF_MARKER, } from "./model-auth-markers.js";
import { normalizeProviderId } from "./model-selection.js";
export { ensureAuthProfileStore, resolveAuthProfileOrder } from "./auth-profiles.js";
export { requireApiKey, resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared.js";
const log = createSubsystemLogger("model-auth");
function resolveProviderConfig(cfg, provider) {
    const providers = cfg?.models?.providers ?? {};
    const direct = providers[provider];
    if (direct) {
        return direct;
    }
    const normalized = normalizeProviderId(provider);
    if (normalized === provider) {
        const matched = Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized);
        return matched?.[1];
    }
    return (providers[normalized] ??
        Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1]);
}
export function getCustomProviderApiKey(cfg, provider) {
    const entry = resolveProviderConfig(cfg, provider);
    const literal = normalizeOptionalSecretInput(entry?.apiKey);
    if (literal) {
        return literal;
    }
    const ref = coerceSecretRef(entry?.apiKey);
    if (!ref) {
        return undefined;
    }
    if (ref.source === "env") {
        const envId = ref.id.trim();
        return envId || NON_ENV_SECRETREF_MARKER;
    }
    return NON_ENV_SECRETREF_MARKER;
}
function canResolveEnvSecretRefInReadOnlyPath(params) {
    const providerConfig = params.cfg?.secrets?.providers?.[params.provider];
    if (!providerConfig) {
        return params.provider === resolveDefaultSecretProviderAlias(params.cfg ?? {}, "env");
    }
    if (providerConfig.source !== "env") {
        return false;
    }
    const allowlist = providerConfig.allowlist;
    return !allowlist || allowlist.includes(params.id);
}
export function resolveUsableCustomProviderApiKey(params) {
    const customProviderConfig = resolveProviderConfig(params.cfg, params.provider);
    const apiKeyRef = coerceSecretRef(customProviderConfig?.apiKey);
    if (apiKeyRef) {
        if (apiKeyRef.source !== "env") {
            return null;
        }
        const envVarName = apiKeyRef.id.trim();
        if (!envVarName) {
            return null;
        }
        if (!canResolveEnvSecretRefInReadOnlyPath({
            cfg: params.cfg,
            provider: apiKeyRef.provider,
            id: envVarName,
        })) {
            return null;
        }
        const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[envVarName]);
        if (!envValue) {
            return null;
        }
        const applied = new Set(getShellEnvAppliedKeys());
        return {
            apiKey: envValue,
            source: resolveEnvSourceLabel({
                applied,
                envVars: [envVarName],
                label: `${envVarName} (models.json secretref)`,
            }),
        };
    }
    const customKey = getCustomProviderApiKey(params.cfg, params.provider);
    if (!customKey) {
        return null;
    }
    if (!isNonSecretApiKeyMarker(customKey)) {
        return { apiKey: customKey, source: "models.json" };
    }
    if (!isKnownEnvApiKeyMarker(customKey)) {
        return null;
    }
    const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[customKey]);
    if (!envValue) {
        return null;
    }
    const applied = new Set(getShellEnvAppliedKeys());
    return {
        apiKey: envValue,
        source: resolveEnvSourceLabel({
            applied,
            envVars: [customKey],
            label: `${customKey} (models.json marker)`,
        }),
    };
}
export function hasUsableCustomProviderApiKey(cfg, provider, env) {
    return Boolean(resolveUsableCustomProviderApiKey({ cfg, provider, env }));
}
export function shouldPreferExplicitConfigApiKeyAuth(cfg, provider) {
    const providerConfig = resolveProviderConfig(cfg, provider);
    return (resolveProviderAuthOverride(cfg, provider) === "api-key" &&
        providerConfig !== undefined &&
        hasExplicitProviderApiKeyConfig(providerConfig));
}
function resolveProviderAuthOverride(cfg, provider) {
    const entry = resolveProviderConfig(cfg, provider);
    const auth = entry?.auth;
    if (auth === "api-key" || auth === "aws-sdk" || auth === "oauth" || auth === "token") {
        return auth;
    }
    return undefined;
}
function isLocalBaseUrl(baseUrl) {
    try {
        const host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
        return (host === "localhost" ||
            host === "127.0.0.1" ||
            host === "0.0.0.0" ||
            host === "[::1]" ||
            host === "[::ffff:7f00:1]" ||
            host === "[::ffff:127.0.0.1]");
    }
    catch {
        return false;
    }
}
function hasExplicitProviderApiKeyConfig(providerConfig) {
    return (normalizeOptionalSecretInput(providerConfig.apiKey) !== undefined ||
        coerceSecretRef(providerConfig.apiKey) !== null);
}
function isCustomLocalProviderConfig(providerConfig) {
    return (typeof providerConfig.baseUrl === "string" &&
        providerConfig.baseUrl.trim().length > 0 &&
        typeof providerConfig.api === "string" &&
        providerConfig.api.trim().length > 0 &&
        Array.isArray(providerConfig.models) &&
        providerConfig.models.length > 0);
}
function isManagedSecretRefApiKeyMarker(apiKey) {
    return apiKey?.trim() === NON_ENV_SECRETREF_MARKER;
}
function resolveProviderSyntheticRuntimeAuth(params) {
    const resolveFromConfig = (config) => {
        const providerConfig = resolveProviderConfig(config, params.provider);
        return (resolveProviderSyntheticAuthWithPlugin({
            provider: params.provider,
            config,
            context: {
                config,
                provider: params.provider,
                providerConfig,
            },
        }) ?? undefined);
    };
    const directAuth = resolveFromConfig(params.cfg);
    if (!directAuth) {
        return {};
    }
    if (!isManagedSecretRefApiKeyMarker(directAuth.apiKey)) {
        return { auth: directAuth };
    }
    const runtimeConfig = getRuntimeConfigSnapshot();
    if (!runtimeConfig || runtimeConfig === params.cfg) {
        return { blockedOnManagedSecretRef: true };
    }
    const runtimeAuth = resolveFromConfig(runtimeConfig);
    const runtimeApiKey = runtimeAuth?.apiKey;
    if (!runtimeAuth || !runtimeApiKey || isNonSecretApiKeyMarker(runtimeApiKey)) {
        return { blockedOnManagedSecretRef: true };
    }
    return {
        auth: runtimeAuth,
    };
}
function resolveSyntheticLocalProviderAuth(params) {
    const syntheticProviderAuth = resolveProviderSyntheticRuntimeAuth(params);
    if (syntheticProviderAuth.auth) {
        return syntheticProviderAuth.auth;
    }
    if (syntheticProviderAuth.blockedOnManagedSecretRef) {
        return null;
    }
    const providerConfig = resolveProviderConfig(params.cfg, params.provider);
    if (!providerConfig) {
        return null;
    }
    const hasApiConfig = Boolean(providerConfig.api?.trim()) ||
        Boolean(providerConfig.baseUrl?.trim()) ||
        (Array.isArray(providerConfig.models) && providerConfig.models.length > 0);
    if (!hasApiConfig) {
        return null;
    }
    const authOverride = resolveProviderAuthOverride(params.cfg, params.provider);
    if (authOverride && authOverride !== "api-key") {
        return null;
    }
    if (!isCustomLocalProviderConfig(providerConfig)) {
        return null;
    }
    if (hasExplicitProviderApiKeyConfig(providerConfig)) {
        return null;
    }
    // Custom providers pointing at a local server (e.g. llama.cpp, vLLM, LocalAI)
    // typically don't require auth. Synthesize a local key so the auth resolver
    // doesn't reject them when the user left the API key blank during setup.
    if (providerConfig.baseUrl && isLocalBaseUrl(providerConfig.baseUrl)) {
        return {
            apiKey: CUSTOM_LOCAL_AUTH_MARKER,
            source: `models.providers.${params.provider} (synthetic local key)`,
            mode: "api-key",
        };
    }
    return null;
}
function resolveEnvSourceLabel(params) {
    const shellApplied = params.envVars.some((envVar) => params.applied.has(envVar));
    const prefix = shellApplied ? "shell env: " : "env: ";
    return `${prefix}${params.label}`;
}
function resolveAwsSdkAuthInfo() {
    const applied = new Set(getShellEnvAppliedKeys());
    if (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
        return {
            mode: "aws-sdk",
            source: resolveEnvSourceLabel({
                applied,
                envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
                label: "AWS_BEARER_TOKEN_BEDROCK",
            }),
        };
    }
    if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
        return {
            mode: "aws-sdk",
            source: resolveEnvSourceLabel({
                applied,
                envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
                label: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
            }),
        };
    }
    if (process.env.AWS_PROFILE?.trim()) {
        return {
            mode: "aws-sdk",
            source: resolveEnvSourceLabel({
                applied,
                envVars: ["AWS_PROFILE"],
                label: "AWS_PROFILE",
            }),
        };
    }
    return { mode: "aws-sdk", source: "aws-sdk default chain" };
}
function shouldDeferSyntheticProfileAuth(params) {
    const providerConfig = resolveProviderConfig(params.cfg, params.provider);
    return (shouldDeferProviderSyntheticProfileAuthWithPlugin({
        provider: params.provider,
        config: params.cfg,
        context: {
            config: params.cfg,
            provider: params.provider,
            providerConfig,
            resolvedApiKey: params.resolvedApiKey,
        },
    }) === true);
}
export async function resolveApiKeyForProvider(params) {
    const { provider, cfg, profileId, preferredProfile } = params;
    if (profileId) {
        const store = params.store ?? ensureAuthProfileStore(params.agentDir);
        const resolved = await resolveApiKeyForProfile({
            cfg,
            store,
            profileId,
            agentDir: params.agentDir,
        });
        if (!resolved) {
            throw new Error(`No credentials found for profile "${profileId}".`);
        }
        const mode = store.profiles[profileId]?.type;
        const result = {
            apiKey: resolved.apiKey,
            profileId,
            source: `profile:${profileId}`,
            mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
        };
        // When the resolved key is a provider-owned synthetic profile marker and
        // the caller has not locked this profile, fall through to env/config
        // resolution so provider-owned real credentials take precedence. The auth
        // controller iterates profile candidates and passes each as an explicit
        // profileId, so we cannot assume explicit === user-locked.
        if (!params.lockedProfile &&
            shouldDeferSyntheticProfileAuth({
                cfg,
                provider,
                resolvedApiKey: resolved.apiKey,
            })) {
            return resolveApiKeyForProvider({ ...params, profileId: undefined, lockedProfile: true }) //
                .catch(() => result);
        }
        return result;
    }
    const authOverride = resolveProviderAuthOverride(cfg, provider);
    if (authOverride === "aws-sdk") {
        return resolveAwsSdkAuthInfo();
    }
    if (shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
        const customKey = resolveUsableCustomProviderApiKey({ cfg, provider });
        if (customKey) {
            return {
                apiKey: customKey.apiKey,
                source: customKey.source,
                mode: "api-key",
            };
        }
    }
    const normalized = normalizeProviderId(provider);
    if (authOverride === undefined && normalized === "amazon-bedrock") {
        return resolveAwsSdkAuthInfo();
    }
    if (params.credentialPrecedence === "env-first") {
        const envResolved = resolveEnvApiKey(provider);
        if (envResolved) {
            const resolvedMode = envResolved.source.includes("OAUTH_TOKEN")
                ? "oauth"
                : "api-key";
            return {
                apiKey: envResolved.apiKey,
                source: envResolved.source,
                mode: resolvedMode,
            };
        }
    }
    const providerConfig = resolveProviderConfig(cfg, provider);
    const store = params.store ?? ensureAuthProfileStore(params.agentDir);
    const order = resolveAuthProfileOrder({
        cfg,
        store,
        provider,
        preferredProfile,
    });
    let deferredAuthProfileResult = null;
    for (const candidate of order) {
        try {
            const resolved = await resolveApiKeyForProfile({
                cfg,
                store,
                profileId: candidate,
                agentDir: params.agentDir,
            });
            if (resolved) {
                const mode = store.profiles[candidate]?.type;
                const resolvedMode = mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key";
                const result = {
                    apiKey: resolved.apiKey,
                    profileId: candidate,
                    source: `profile:${candidate}`,
                    mode: resolvedMode,
                };
                if (shouldDeferSyntheticProfileAuth({
                    cfg,
                    provider,
                    resolvedApiKey: resolved.apiKey,
                })) {
                    deferredAuthProfileResult ??= result;
                    continue;
                }
                return result;
            }
        }
        catch (err) {
            log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
        }
    }
    const envResolved = resolveEnvApiKey(provider);
    if (envResolved) {
        const resolvedMode = envResolved.source.includes("OAUTH_TOKEN")
            ? "oauth"
            : "api-key";
        const result = {
            apiKey: envResolved.apiKey,
            source: envResolved.source,
            mode: resolvedMode,
        };
        return result;
    }
    const customKey = resolveUsableCustomProviderApiKey({ cfg, provider });
    if (customKey) {
        const result = { apiKey: customKey.apiKey, source: customKey.source, mode: "api-key" };
        return result;
    }
    if (deferredAuthProfileResult) {
        return deferredAuthProfileResult;
    }
    const syntheticLocalAuth = resolveSyntheticLocalProviderAuth({ cfg, provider });
    if (syntheticLocalAuth) {
        return syntheticLocalAuth;
    }
    const hasInlineConfiguredModels = Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
    const owningPluginIds = !hasInlineConfiguredModels
        ? resolveOwningPluginIdsForProvider({
            provider,
            config: cfg,
        })
        : undefined;
    if (owningPluginIds?.length) {
        const pluginMissingAuthMessage = buildProviderMissingAuthMessageWithPlugin({
            provider,
            config: cfg,
            context: {
                config: cfg,
                agentDir: params.agentDir,
                env: process.env,
                provider,
                listProfileIds: (providerId) => listProfilesForProvider(store, providerId),
            },
        });
        if (pluginMissingAuthMessage) {
            throw new Error(pluginMissingAuthMessage);
        }
    }
    const authStorePath = resolveAuthStorePathForDisplay(params.agentDir);
    const resolvedAgentDir = path.dirname(authStorePath);
    throw new Error([
        `No API key found for provider "${provider}".`,
        `Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
        `Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy auth-profiles.json from the main agentDir.`,
    ].join(" "));
}
export { resolveEnvApiKey } from "./model-auth-env.js";
export function resolveModelAuthMode(provider, cfg, store) {
    const resolved = provider?.trim();
    if (!resolved) {
        return undefined;
    }
    const authOverride = resolveProviderAuthOverride(cfg, resolved);
    if (authOverride === "aws-sdk") {
        return "aws-sdk";
    }
    const authStore = store ?? ensureAuthProfileStore();
    const profiles = listProfilesForProvider(authStore, resolved);
    if (profiles.length > 0) {
        const modes = new Set(profiles
            .map((id) => authStore.profiles[id]?.type)
            .filter((mode) => Boolean(mode)));
        const distinct = ["oauth", "token", "api_key"].filter((k) => modes.has(k));
        if (distinct.length >= 2) {
            return "mixed";
        }
        if (modes.has("oauth")) {
            return "oauth";
        }
        if (modes.has("token")) {
            return "token";
        }
        if (modes.has("api_key")) {
            return "api-key";
        }
    }
    if (authOverride === undefined && normalizeProviderId(resolved) === "amazon-bedrock") {
        return "aws-sdk";
    }
    const envKey = resolveEnvApiKey(resolved);
    if (envKey?.apiKey) {
        return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
    }
    if (normalizeProviderId(resolved) === "codex" &&
        cliCredentials.readCodexCliCredentialsCached({ ttlMs: 5_000 })) {
        return "oauth";
    }
    if (hasUsableCustomProviderApiKey(cfg, resolved)) {
        return "api-key";
    }
    return "unknown";
}
export async function hasAvailableAuthForProvider(params) {
    const { provider, cfg, preferredProfile } = params;
    const authOverride = resolveProviderAuthOverride(cfg, provider);
    if (authOverride === "aws-sdk") {
        return true;
    }
    if (resolveEnvApiKey(provider)) {
        return true;
    }
    if (resolveUsableCustomProviderApiKey({ cfg, provider })) {
        return true;
    }
    if (resolveSyntheticLocalProviderAuth({ cfg, provider })) {
        return true;
    }
    if (authOverride === undefined && normalizeProviderId(provider) === "amazon-bedrock") {
        return true;
    }
    const store = params.store ?? ensureAuthProfileStore(params.agentDir);
    const order = resolveAuthProfileOrder({
        cfg,
        store,
        provider,
        preferredProfile,
    });
    for (const candidate of order) {
        try {
            const resolved = await resolveApiKeyForProfile({
                cfg,
                store,
                profileId: candidate,
                agentDir: params.agentDir,
            });
            if (resolved) {
                return true;
            }
        }
        catch (err) {
            log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
        }
    }
    return false;
}
export async function getApiKeyForModel(params) {
    return resolveApiKeyForProvider({
        provider: params.model.provider,
        cfg: params.cfg,
        profileId: params.profileId,
        preferredProfile: params.preferredProfile,
        store: params.store,
        agentDir: params.agentDir,
        lockedProfile: params.lockedProfile,
        credentialPrecedence: params.credentialPrecedence,
    });
}
export function applyLocalNoAuthHeaderOverride(model, auth) {
    if (auth?.apiKey !== CUSTOM_LOCAL_AUTH_MARKER || model.api !== "openai-completions") {
        return model;
    }
    // OpenAI's SDK always generates Authorization from apiKey. Keep the non-secret
    // placeholder so construction succeeds, then clear the header at request build
    // time for local servers that intentionally do not require auth.
    const headers = {
        ...model.headers,
        Authorization: null,
    };
    return {
        ...model,
        headers,
    };
}
/**
 * When the provider config sets `authHeader: true`, inject an explicit
 * `Authorization: Bearer <apiKey>` header into the model so downstream SDKs
 * (e.g. `@google/genai`) send credentials via the standard HTTP Authorization
 * header instead of vendor-specific headers like `x-goog-api-key`.
 *
 * This is a no-op when `authHeader` is not `true`, when no API key is
 * available, or when the API key is a synthetic marker (e.g. local-server
 * placeholders) rather than a real credential.
 */
export function applyAuthHeaderOverride(model, auth, cfg) {
    if (!auth?.apiKey) {
        return model;
    }
    // Reject synthetic marker values that are not real credentials.
    if (isNonSecretApiKeyMarker(auth.apiKey)) {
        return model;
    }
    const providerConfig = resolveProviderConfig(cfg, model.provider);
    if (!providerConfig?.authHeader) {
        return model;
    }
    // Strip any existing authorization header (case-insensitive) before
    // injecting the canonical one so we don't produce a comma-joined value.
    const headers = {};
    if (model.headers) {
        for (const [key, value] of Object.entries(model.headers)) {
            if (normalizeOptionalLowercaseString(key) !== "authorization") {
                headers[key] = value;
            }
        }
    }
    headers.Authorization = `Bearer ${auth.apiKey}`;
    return {
        ...model,
        headers,
    };
}
