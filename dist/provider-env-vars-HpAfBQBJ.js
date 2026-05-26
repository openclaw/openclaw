import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { d as isInstalledPluginEnabled } from "./installed-plugin-index-store-C1Oen9wR.js";
import { r as hasKind } from "./slots-DT22cOei.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { a as normalizePluginConfigId, i as isWorkspacePluginAllowedByConfig, n as resolveProviderAuthAliasMap } from "./provider-auth-aliases-4jqi6Djx.js";
//#region src/secrets/provider-env-vars.ts
const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	voyage: ["VOYAGE_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	"anthropic-openai": ["ANTHROPIC_API_KEY"],
	"qwen-dashscope": ["DASHSCOPE_API_KEY"]
};
const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_API_KEY"]
};
function isWorkspacePluginTrustedForProviderEnvVars(plugin, config) {
	return isWorkspacePluginAllowedByConfig({
		config,
		isImplicitlyAllowed: (pluginId) => hasKind(plugin.kind, "context-engine") && normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
		plugin
	});
}
function shouldUsePluginProviderEnvVars(plugin, params) {
	if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins !== false) return true;
	return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}
function shouldUsePluginProviderAuthEvidence(plugin, params) {
	if (plugin.origin !== "workspace") return true;
	return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}
function appendUniqueEnvVarCandidates(target, providerId, keys) {
	const normalizedProviderId = providerId.trim();
	if (!normalizedProviderId || keys.length === 0) return;
	const bucket = target[normalizedProviderId] ??= [];
	const seen = new Set(bucket);
	for (const key of keys) {
		const normalizedKey = key.trim();
		if (!normalizedKey || seen.has(normalizedKey)) continue;
		seen.add(normalizedKey);
		bucket.push(normalizedKey);
	}
}
function appendUniqueAuthEvidence(target, providerId, evidence) {
	const normalizedProviderId = providerId.trim();
	if (!normalizedProviderId || evidence.length === 0) return;
	const bucket = target[normalizedProviderId] ??= [];
	const seen = new Set(bucket.map((entry) => JSON.stringify(entry)));
	for (const entry of evidence) {
		const key = JSON.stringify(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		bucket.push(entry);
	}
}
function resolveProviderMetadataSnapshot(params) {
	if (params?.metadataSnapshot) return params.metadataSnapshot;
	const config = params?.config ?? {};
	const env = params?.env ?? process.env;
	const current = getCurrentPluginMetadataSnapshot({
		config,
		env,
		...params?.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		allowWorkspaceScopedSnapshot: true
	});
	if (current) return current;
	if (normalizePluginsConfig(config.plugins).loadPaths.length === 0) {
		const unscopedCurrent = getCurrentPluginMetadataSnapshot({
			env,
			...params?.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
			allowWorkspaceScopedSnapshot: true,
			requireDefaultDiscoveryContext: true
		});
		if (unscopedCurrent) return unscopedCurrent;
	}
	return loadPluginMetadataSnapshot({
		config,
		workspaceDir: params?.workspaceDir,
		env,
		preferPersisted: false
	});
}
function resolveManifestProviderAuthEnvVarCandidates(params) {
	const snapshot = resolveProviderMetadataSnapshot(params);
	const candidates = {};
	for (const plugin of snapshot.plugins) {
		if (!shouldUsePluginProviderEnvVars(plugin, params)) continue;
		if (plugin.providerAuthEnvVars) for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(([left], [right]) => left.localeCompare(right))) appendUniqueEnvVarCandidates(candidates, providerId, keys);
		for (const provider of plugin.setup?.providers ?? []) appendUniqueEnvVarCandidates(candidates, provider.id, provider.envVars ?? []);
	}
	const aliases = resolveProviderAuthAliasMap(params);
	for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) => left.localeCompare(right))) {
		const keys = candidates[target];
		if (keys) appendUniqueEnvVarCandidates(candidates, alias, keys);
	}
	return candidates;
}
function resolveManifestProviderAuthEvidence(params) {
	const snapshot = resolveProviderMetadataSnapshot(params);
	const evidenceByProvider = {};
	for (const plugin of snapshot.plugins) {
		if (snapshot.index.plugins.length > 0 && !isInstalledPluginEnabled(snapshot.index, plugin.id, params?.config)) continue;
		if (!shouldUsePluginProviderAuthEvidence(plugin, params)) continue;
		for (const provider of plugin.setup?.providers ?? []) appendUniqueAuthEvidence(evidenceByProvider, provider.id, provider.authEvidence ?? []);
	}
	const aliases = resolveProviderAuthAliasMap(params);
	for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) => left.localeCompare(right))) {
		const evidence = evidenceByProvider[target];
		if (evidence) appendUniqueAuthEvidence(evidenceByProvider, alias, evidence);
	}
	return evidenceByProvider;
}
function resolveProviderAuthEnvVarCandidates(params) {
	return {
		...resolveManifestProviderAuthEnvVarCandidates(params),
		...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES
	};
}
function resolveProviderAuthEvidence(params) {
	return resolveManifestProviderAuthEvidence(params);
}
function resolveProviderEnvVars(params) {
	return {
		...resolveProviderAuthEnvVarCandidates(params),
		...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES
	};
}
const lazyRecordCacheResetters = /* @__PURE__ */ new Set();
function createLazyReadonlyRecord(resolve) {
	let cached;
	lazyRecordCacheResetters.add(() => {
		cached = void 0;
	});
	const getResolved = () => {
		cached ??= resolve();
		return cached;
	};
	return new Proxy({}, {
		get(_target, prop) {
			if (typeof prop !== "string") return;
			return getResolved()[prop];
		},
		has(_target, prop) {
			return typeof prop === "string" && Object.hasOwn(getResolved(), prop);
		},
		ownKeys() {
			return Reflect.ownKeys(getResolved());
		},
		getOwnPropertyDescriptor(_target, prop) {
			if (typeof prop !== "string") return;
			const value = getResolved()[prop];
			if (value === void 0) return;
			return {
				configurable: true,
				enumerable: true,
				value,
				writable: false
			};
		}
	});
}
createLazyReadonlyRecord(() => resolveProviderAuthEnvVarCandidates());
/**
* Provider env vars used for setup/default secret refs and broad secret
* scrubbing. This can include non-model providers and may intentionally choose
* a different preferred first env var than auth resolution.
*
* Bundled provider auth envs come from plugin manifests. The override map here
* is only for true core/non-plugin providers and a few setup-specific ordering
* overrides where generic onboarding wants a different preferred env var.
*/
const PROVIDER_ENV_VARS = createLazyReadonlyRecord(() => resolveProviderEnvVars());
function getProviderEnvVars(providerId, params) {
	const providerEnvVars = params ? resolveProviderEnvVars(params) : PROVIDER_ENV_VARS;
	const envVars = Object.hasOwn(providerEnvVars, providerId) ? providerEnvVars[providerId] : void 0;
	return Array.isArray(envVars) ? [...envVars] : [];
}
function listKnownProviderAuthEnvVarNames(params) {
	return [...new Set([...Object.values(resolveProviderAuthEnvVarCandidates(params)).flatMap((keys) => keys), ...Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys)])];
}
function listKnownSecretEnvVarNames(params) {
	return [...new Set(Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys))];
}
function omitEnvKeysCaseInsensitive(baseEnv, keys) {
	const env = { ...baseEnv };
	const denied = /* @__PURE__ */ new Set();
	for (const key of keys) {
		const normalizedKey = key.trim();
		if (normalizedKey) denied.add(normalizedKey.toUpperCase());
	}
	if (denied.size === 0) return env;
	for (const actualKey of Object.keys(env)) if (denied.has(actualKey.toUpperCase())) delete env[actualKey];
	return env;
}
//#endregion
export { resolveProviderAuthEnvVarCandidates as a, omitEnvKeysCaseInsensitive as i, listKnownProviderAuthEnvVarNames as n, resolveProviderAuthEvidence as o, listKnownSecretEnvVarNames as r, getProviderEnvVars as t };
