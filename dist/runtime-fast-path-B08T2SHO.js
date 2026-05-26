import { v as resolveOAuthPath } from "./paths-Cw7f9XhU.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { a as resolveAgentDir, n as listAgentIds, s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import "./path-resolve-C6Vj5eOM.js";
import { existsSync } from "node:fs";
import path from "node:path";
//#region src/secrets/runtime-fast-path.ts
const RUNTIME_PATH_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"OPENCLAW_HOME",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_CONFIG_PATH",
	"OPENCLAW_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"OPENCLAW_TEST_FAST"
];
function mergeSecretsRuntimeEnv(env) {
	const merged = { ...env ?? process.env };
	for (const key of RUNTIME_PATH_ENV_KEYS) {
		if (merged[key] !== void 0) continue;
		const processValue = process.env[key];
		if (processValue !== void 0) merged[key] = processValue;
	}
	return merged;
}
function collectCandidateAgentDirs(config, env = process.env) {
	const dirs = /* @__PURE__ */ new Set();
	dirs.add(resolveUserPath(resolveDefaultAgentDir(config, env), env));
	for (const agentId of listAgentIds(config)) dirs.add(resolveUserPath(resolveAgentDir(config, agentId, env), env));
	return [...dirs];
}
function resolveRefreshAgentDirs(config, context) {
	const configDerived = collectCandidateAgentDirs(config, context.env);
	if (!context.explicitAgentDirs || context.explicitAgentDirs.length === 0) return configDerived;
	return [...new Set([...context.explicitAgentDirs, ...configDerived])];
}
function resolveCandidateAgentDirs(params) {
	return params.agentDirs?.length ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, params.env)))] : collectCandidateAgentDirs(params.config, params.env);
}
function hasCandidateAuthProfileStoreSource(agentDir) {
	return existsSync(path.join(agentDir, "auth-profiles.json")) || existsSync(path.join(agentDir, "auth-state.json")) || existsSync(path.join(agentDir, "auth.json"));
}
function hasCandidateAuthProfileStoreSources(params) {
	const candidateDirs = resolveCandidateAgentDirs(params);
	const mainAgentDir = resolveUserPath(resolveDefaultAgentDir({}, params.env), params.env);
	return candidateDirs.some((agentDir) => hasCandidateAuthProfileStoreSource(agentDir)) || hasCandidateAuthProfileStoreSource(mainAgentDir) || existsSync(resolveOAuthPath(params.env));
}
function createEmptyRuntimeWebToolsMetadata() {
	return {
		search: {
			providerSource: "none",
			diagnostics: []
		},
		fetch: {
			providerSource: "none",
			diagnostics: []
		},
		diagnostics: []
	};
}
const WEB_FETCH_CREDENTIAL_FIELD_NAMES = new Set([
	"apikey",
	"key",
	"token",
	"secret",
	"password"
]);
function hasCredentialBearingWebFetchValue(value, defaults, seen = /* @__PURE__ */ new WeakSet()) {
	if (coerceSecretRef(value, defaults)) return true;
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((entry) => hasCredentialBearingWebFetchValue(entry, defaults, seen));
	return Object.entries(value).some(([rawKey, entry]) => {
		const key = rawKey.toLowerCase();
		if (WEB_FETCH_CREDENTIAL_FIELD_NAMES.has(key) && entry != null && entry !== "") return true;
		return hasCredentialBearingWebFetchValue(entry, defaults, seen);
	});
}
function hasActiveRuntimeWebFetchProviderSurface(fetch, defaults) {
	if (!fetch || typeof fetch !== "object" || Array.isArray(fetch)) return false;
	const fetchConfig = fetch;
	if (fetchConfig.enabled === false) return false;
	if (typeof fetchConfig.provider === "string" && fetchConfig.provider.trim()) return true;
	return hasCredentialBearingWebFetchValue(fetchConfig, defaults);
}
function hasRuntimeWebToolConfigSurface(config) {
	const web = config.tools?.web;
	const defaults = config.secrets?.defaults;
	const fetchExplicitlyDisabled = web && typeof web === "object" && !Array.isArray(web) && typeof web.fetch === "object" && web.fetch?.enabled === false;
	if (web && typeof web === "object" && !Array.isArray(web)) {
		const webRecord = web;
		if ("search" in webRecord || "x_search" in webRecord) return true;
		if ("fetch" in webRecord && hasActiveRuntimeWebFetchProviderSurface(webRecord.fetch, defaults)) return true;
	}
	const entries = config.plugins?.entries;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
	return Object.values(entries).some((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const pluginConfig = entry.config;
		return !!pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig) && ("webSearch" in pluginConfig || !fetchExplicitlyDisabled && "webFetch" in pluginConfig);
	});
}
function hasSecretRefCandidate(value, defaults, seen = /* @__PURE__ */ new WeakSet()) {
	if (coerceSecretRef(value, defaults)) return true;
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((entry) => hasSecretRefCandidate(entry, defaults, seen));
	return Object.values(value).some((entry) => hasSecretRefCandidate(entry, defaults, seen));
}
function canUseSecretsRuntimeFastPath(params) {
	if (hasRuntimeWebToolConfigSurface(params.sourceConfig)) return false;
	const defaults = params.sourceConfig.secrets?.defaults;
	if (hasSecretRefCandidate(params.sourceConfig, defaults)) return false;
	return !params.authStores.some((entry) => hasSecretRefCandidate(entry.store, defaults));
}
function prepareSecretsRuntimeFastPathSnapshot(params) {
	const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
	const sourceConfig = structuredClone(params.config);
	const resolvedConfig = structuredClone(params.config);
	const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
	const candidateDirs = resolveCandidateAgentDirs({
		config: resolvedConfig,
		env: runtimeEnv,
		agentDirs: params.agentDirs
	});
	let authStores = [];
	if (includeAuthStoreRefs) if (!params.loadAuthStore) {
		if (hasCandidateAuthProfileStoreSources({
			config: resolvedConfig,
			env: runtimeEnv,
			agentDirs: candidateDirs
		})) return null;
		authStores = candidateDirs.map((agentDir) => ({
			agentDir,
			store: {
				version: 1,
				profiles: {}
			}
		}));
	} else {
		const loadAuthStore = params.loadAuthStore;
		authStores = candidateDirs.map((agentDir) => ({
			agentDir,
			store: structuredClone(loadAuthStore(agentDir))
		}));
	}
	if (!canUseSecretsRuntimeFastPath({
		sourceConfig,
		authStores
	})) return null;
	return {
		snapshot: {
			sourceConfig,
			config: resolvedConfig,
			authStores,
			warnings: [],
			webTools: createEmptyRuntimeWebToolsMetadata()
		},
		usesAuthStoreFallback: !params.loadAuthStore,
		refreshContext: {
			env: runtimeEnv,
			explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
			includeAuthStoreRefs,
			loadablePluginOrigins: params.loadablePluginOrigins ?? /* @__PURE__ */ new Map(),
			...params.loadAuthStore ? { loadAuthStore: params.loadAuthStore } : {}
		}
	};
}
//#endregion
export { prepareSecretsRuntimeFastPathSnapshot as a, mergeSecretsRuntimeEnv as i, collectCandidateAgentDirs as n, resolveRefreshAgentDirs as o, createEmptyRuntimeWebToolsMetadata as r, canUseSecretsRuntimeFastPath as t };
