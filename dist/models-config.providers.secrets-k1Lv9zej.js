import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { m as resolveSecretInputRef, o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { M as resolveProviderSyntheticAuthWithPlugin } from "./provider-runtime-D8jQEgmu.js";
import { g as resolveNonEnvSecretRefHeaderValueMarker, h as resolveNonEnvSecretRefApiKeyMarker, l as isKnownEnvApiKeyMarker, m as resolveEnvSecretRefHeaderValueMarker, u as isNonSecretApiKeyMarker } from "./model-auth-markers-Cf78z2Zm.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import { r as resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared-cdTr1v5l.js";
//#region src/agents/models-config.providers.secret-helpers.ts
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
function normalizeApiKeyConfig(value) {
	const trimmed = value.trim();
	return /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed)?.[1] ?? trimmed;
}
function toDiscoveryApiKey(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed || isNonSecretApiKeyMarker(trimmed)) return;
	return trimmed;
}
function resolveEnvApiKeyVarName(provider, env = process.env) {
	const resolved = resolveEnvApiKey(provider, env);
	if (!resolved) return;
	const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
	return match ? match[1] : void 0;
}
function resolveAwsSdkApiKeyVarName(env = process.env) {
	return resolveAwsSdkEnvVarName(env);
}
function normalizeHeaderValues(params) {
	const { headers } = params;
	if (!headers) return {
		headers,
		mutated: false
	};
	let mutated = false;
	const nextHeaders = {};
	for (const [headerName, headerValue] of Object.entries(headers)) {
		const resolvedRef = resolveSecretInputRef({
			value: headerValue,
			defaults: params.secretDefaults
		}).ref;
		if (!resolvedRef || !resolvedRef.id.trim()) {
			nextHeaders[headerName] = headerValue;
			continue;
		}
		mutated = true;
		nextHeaders[headerName] = resolvedRef.source === "env" ? resolveEnvSecretRefHeaderValueMarker(resolvedRef.id) : resolveNonEnvSecretRefHeaderValueMarker(resolvedRef.source);
	}
	if (!mutated) return {
		headers,
		mutated: false
	};
	return {
		headers: nextHeaders,
		mutated: true
	};
}
function resolveApiKeyFromCredential(cred, env = process.env) {
	if (!cred) return;
	if (cred.type === "api_key") {
		const keyRef = coerceSecretRef(cred.keyRef);
		if (keyRef && keyRef.id.trim()) {
			if (keyRef.source === "env") {
				const envVar = keyRef.id.trim();
				return {
					apiKey: envVar,
					source: "env-ref",
					discoveryApiKey: toDiscoveryApiKey(env[envVar])
				};
			}
			return {
				apiKey: resolveNonEnvSecretRefApiKeyMarker(keyRef.source),
				source: "non-env-ref"
			};
		}
		if (cred.key?.trim()) return {
			apiKey: cred.key,
			source: "plaintext",
			discoveryApiKey: toDiscoveryApiKey(cred.key)
		};
		return;
	}
	if (cred.type === "token") {
		const tokenRef = coerceSecretRef(cred.tokenRef);
		if (tokenRef && tokenRef.id.trim()) {
			if (tokenRef.source === "env") {
				const envVar = tokenRef.id.trim();
				return {
					apiKey: envVar,
					source: "env-ref",
					discoveryApiKey: toDiscoveryApiKey(env[envVar])
				};
			}
			return {
				apiKey: resolveNonEnvSecretRefApiKeyMarker(tokenRef.source),
				source: "non-env-ref"
			};
		}
		if (cred.token?.trim()) return {
			apiKey: cred.token,
			source: "plaintext",
			discoveryApiKey: toDiscoveryApiKey(cred.token)
		};
	}
}
function listAuthProfilesForProvider(store, provider) {
	const providerKey = resolveProviderIdForAuth(provider);
	return Object.entries(store.profiles).filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey).map(([id]) => id);
}
function resolveApiKeyFromProfiles(params) {
	const ids = listAuthProfilesForProvider(params.store, params.provider);
	for (const id of ids) {
		const resolved = resolveApiKeyFromCredential(params.store.profiles[id], params.env);
		if (resolved) return resolved;
	}
}
function normalizeConfiguredProviderApiKey(params) {
	const configuredApiKey = params.provider.apiKey;
	const configuredApiKeyRef = resolveSecretInputRef({
		value: configuredApiKey,
		defaults: params.secretDefaults
	}).ref;
	if (configuredApiKeyRef && configuredApiKeyRef.id.trim()) {
		const marker = configuredApiKeyRef.source === "env" ? configuredApiKeyRef.id.trim() : resolveNonEnvSecretRefApiKeyMarker(configuredApiKeyRef.source);
		params.secretRefManagedProviders?.add(params.providerKey);
		if (params.provider.apiKey === marker) return params.provider;
		return {
			...params.provider,
			apiKey: marker
		};
	}
	if (typeof configuredApiKey !== "string") return params.provider;
	const normalizedConfiguredApiKey = normalizeApiKeyConfig(configuredApiKey);
	if (isNonSecretApiKeyMarker(normalizedConfiguredApiKey)) params.secretRefManagedProviders?.add(params.providerKey);
	if (params.profileApiKey && params.profileApiKey.source !== "plaintext" && normalizedConfiguredApiKey === params.profileApiKey.apiKey) params.secretRefManagedProviders?.add(params.providerKey);
	if (normalizedConfiguredApiKey === configuredApiKey) return params.provider;
	return {
		...params.provider,
		apiKey: normalizedConfiguredApiKey
	};
}
function normalizeResolvedEnvApiKey(params) {
	const currentApiKey = params.provider.apiKey;
	if (typeof currentApiKey !== "string" || !currentApiKey.trim() || ENV_VAR_NAME_RE.test(currentApiKey.trim())) return params.provider;
	const envVarName = resolveEnvApiKeyVarName(params.providerKey, params.env);
	if (!envVarName || params.env[envVarName] !== currentApiKey) return params.provider;
	params.secretRefManagedProviders?.add(params.providerKey);
	return {
		...params.provider,
		apiKey: envVarName
	};
}
function resolveMissingProviderApiKey(params) {
	const hasModels = Array.isArray(params.provider.models) && params.provider.models.length > 0;
	const normalizedApiKey = normalizeOptionalSecretInput(params.provider.apiKey);
	const hasConfiguredApiKey = Boolean(normalizedApiKey || params.provider.apiKey);
	if (!hasModels || hasConfiguredApiKey) return params.provider;
	const authMode = params.provider.auth;
	if (params.providerApiKeyResolver && (!authMode || authMode === "aws-sdk")) {
		const resolvedApiKey = params.providerApiKeyResolver(params.env);
		if (!resolvedApiKey) return params.provider;
		return {
			...params.provider,
			apiKey: resolvedApiKey
		};
	}
	if (authMode === "aws-sdk") {
		const awsEnvVar = resolveAwsSdkApiKeyVarName(params.env);
		if (!awsEnvVar) return params.provider;
		return {
			...params.provider,
			apiKey: awsEnvVar
		};
	}
	const apiKey = resolveEnvApiKeyVarName(params.providerKey, params.env) ?? params.profileApiKey?.apiKey;
	if (!apiKey?.trim()) return params.provider;
	if (params.profileApiKey && params.profileApiKey.source !== "plaintext") params.secretRefManagedProviders?.add(params.providerKey);
	return {
		...params.provider,
		apiKey
	};
}
//#endregion
//#region src/agents/models-config.providers.secrets.ts
function resolveAuthProfileStoreInput(input) {
	return typeof input === "function" ? input() : input;
}
function createProviderApiKeyResolver(env, authStoreInput, config) {
	return (provider) => {
		const authProvider = resolveProviderIdForAuth(provider, {
			config,
			env
		});
		const envVar = resolveEnvApiKeyVarName(authProvider, env);
		if (envVar) return {
			apiKey: envVar,
			discoveryApiKey: toDiscoveryApiKey(env[envVar])
		};
		const fromConfig = resolveConfigBackedProviderAuth({
			provider: authProvider,
			config,
			env
		});
		if (fromConfig?.apiKey) return {
			apiKey: fromConfig.apiKey,
			discoveryApiKey: fromConfig.discoveryApiKey
		};
		const fromProfiles = resolveApiKeyFromProfiles({
			provider: authProvider,
			store: resolveAuthProfileStoreInput(authStoreInput),
			env
		});
		return fromProfiles?.apiKey ? {
			apiKey: fromProfiles.apiKey,
			discoveryApiKey: fromProfiles.discoveryApiKey
		} : {
			apiKey: void 0,
			discoveryApiKey: void 0
		};
	};
}
function createProviderAuthResolver(env, authStoreInput, config) {
	return (provider, options) => {
		const authProvider = resolveProviderIdForAuth(provider, {
			config,
			env
		});
		const authStore = resolveAuthProfileStoreInput(authStoreInput);
		const ids = listAuthProfilesForProvider(authStore, authProvider);
		let oauthCandidate;
		for (const id of ids) {
			const cred = authStore.profiles[id];
			if (!cred) continue;
			if (cred.type === "oauth") {
				oauthCandidate ??= {
					apiKey: options?.oauthMarker,
					discoveryApiKey: toDiscoveryApiKey(cred.access),
					mode: "oauth",
					source: "profile",
					profileId: id
				};
				continue;
			}
			const resolved = resolveApiKeyFromCredential(cred, env);
			if (!resolved) continue;
			return {
				apiKey: resolved.apiKey,
				discoveryApiKey: resolved.discoveryApiKey,
				mode: cred.type,
				source: "profile",
				profileId: id
			};
		}
		if (oauthCandidate) return oauthCandidate;
		const envVar = resolveEnvApiKeyVarName(authProvider, env);
		if (envVar) return {
			apiKey: envVar,
			discoveryApiKey: toDiscoveryApiKey(env[envVar]),
			mode: "api_key",
			source: "env"
		};
		const fromConfig = resolveConfigBackedProviderAuth({
			provider: authProvider,
			config,
			env
		});
		if (fromConfig) return {
			apiKey: fromConfig.apiKey,
			discoveryApiKey: fromConfig.discoveryApiKey,
			mode: fromConfig.mode,
			source: "none"
		};
		return {
			apiKey: void 0,
			discoveryApiKey: void 0,
			mode: "none",
			source: "none"
		};
	};
}
function resolveConfigBackedProviderAuth(params) {
	const authProvider = resolveProviderIdForAuth(params.provider, { config: params.config });
	const apiKey = resolveProviderSyntheticAuthWithPlugin({
		provider: authProvider,
		config: params.config,
		context: {
			config: params.config,
			provider: authProvider,
			providerConfig: params.config?.models?.providers?.[authProvider]
		}
	})?.apiKey?.trim();
	if (apiKey) return isNonSecretApiKeyMarker(apiKey) ? {
		apiKey,
		discoveryApiKey: toDiscoveryApiKey(apiKey),
		mode: "api_key",
		source: "config"
	} : {
		apiKey: resolveNonEnvSecretRefApiKeyMarker("file"),
		discoveryApiKey: toDiscoveryApiKey(apiKey),
		mode: "api_key",
		source: "config"
	};
	const configuredProviderApiKey = (params.config?.models?.providers?.[authProvider])?.apiKey;
	const configuredApiKeyRef = resolveSecretInputRef({
		value: configuredProviderApiKey,
		defaults: params.config?.secrets?.defaults
	}).ref;
	if (configuredApiKeyRef) {
		if (configuredApiKeyRef.source === "env") {
			const envVar = configuredApiKeyRef.id.trim();
			const envValue = params.env?.[envVar]?.trim();
			return envValue ? {
				apiKey: envVar,
				discoveryApiKey: toDiscoveryApiKey(envValue),
				mode: "api_key",
				source: "config"
			} : void 0;
		}
		return {
			apiKey: resolveNonEnvSecretRefApiKeyMarker(configuredApiKeyRef.source),
			discoveryApiKey: void 0,
			mode: "api_key",
			source: "config"
		};
	}
	if (typeof configuredProviderApiKey !== "string") return;
	const configuredApiKey = normalizeApiKeyConfig(configuredProviderApiKey);
	if (!configuredApiKey) return;
	if (isKnownEnvApiKeyMarker(configuredApiKey)) {
		const envValue = params.env?.[configuredApiKey]?.trim();
		if (envValue) return {
			apiKey: configuredApiKey,
			discoveryApiKey: toDiscoveryApiKey(envValue),
			mode: "api_key",
			source: "config"
		};
		return;
	}
	return isNonSecretApiKeyMarker(configuredApiKey) ? {
		apiKey: configuredApiKey,
		discoveryApiKey: toDiscoveryApiKey(configuredApiKey),
		mode: "api_key",
		source: "config"
	} : {
		apiKey: configuredApiKey,
		discoveryApiKey: toDiscoveryApiKey(configuredApiKey),
		mode: "api_key",
		source: "config"
	};
}
//#endregion
export { normalizeHeaderValues as a, resolveMissingProviderApiKey as c, normalizeConfiguredProviderApiKey as i, createProviderAuthResolver as n, normalizeResolvedEnvApiKey as o, normalizeApiKeyConfig as r, resolveApiKeyFromProfiles as s, createProviderApiKeyResolver as t };
