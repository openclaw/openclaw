import { p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { o as coerceSecretRef } from "./types.secrets-BxqheYvy.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, n as listAgentIds, o as resolveAgentWorkspaceDir, s as resolveDefaultAgentDir } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { _ as setRuntimeConfigSnapshot, t as clearRuntimeConfigSnapshot, v as setRuntimeConfigSnapshotRefreshHandler } from "./runtime-snapshot-tLK3Mx7y.js";
import "./config-CzeRK-GW.js";
import { c as loadAuthProfileStoreForSecretsRuntime, l as loadAuthProfileStoreWithoutExternalProfiles, t as clearRuntimeAuthProfileStoreSnapshots, u as replaceRuntimeAuthProfileStoreSnapshots } from "./store-a4exFSck.js";
import "./auth-profiles-vKILPyQ8.js";
import { n as getActiveRuntimeWebToolsMetadata$1, r as setActiveRuntimeWebToolsMetadata, t as clearActiveRuntimeWebToolsMetadata } from "./runtime-web-tools-state-BjmmBRUl.js";
//#region src/secrets/runtime.ts
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
let activeSnapshot = null;
let activeRefreshContext = null;
const preparedSnapshotRefreshContext = /* @__PURE__ */ new WeakMap();
let runtimeManifestPromise = null;
let runtimePreparePromise = null;
function loadRuntimeManifestHelpers() {
	runtimeManifestPromise ??= import("./runtime-manifest.runtime.js");
	return runtimeManifestPromise;
}
function loadRuntimePrepareHelpers() {
	runtimePreparePromise ??= import("./runtime-prepare.runtime.js");
	return runtimePreparePromise;
}
function cloneSnapshot(snapshot) {
	return {
		sourceConfig: structuredClone(snapshot.sourceConfig),
		config: structuredClone(snapshot.config),
		authStores: snapshot.authStores.map((entry) => ({
			agentDir: entry.agentDir,
			store: structuredClone(entry.store)
		})),
		warnings: snapshot.warnings.map((warning) => ({ ...warning })),
		webTools: structuredClone(snapshot.webTools)
	};
}
function cloneRefreshContext(context) {
	return {
		env: { ...context.env },
		explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
		loadAuthStore: context.loadAuthStore,
		loadablePluginOrigins: new Map(context.loadablePluginOrigins)
	};
}
function clearActiveSecretsRuntimeState() {
	activeSnapshot = null;
	activeRefreshContext = null;
	clearActiveRuntimeWebToolsMetadata();
	setRuntimeConfigSnapshotRefreshHandler(null);
	clearRuntimeConfigSnapshot();
	clearRuntimeAuthProfileStoreSnapshots();
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
async function resolveLoadablePluginOrigins(params) {
	const workspaceDir = resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
	const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } = await loadRuntimeManifestHelpers();
	return listPluginOriginsFromMetadataSnapshot(loadPluginMetadataSnapshot({
		config: params.config,
		workspaceDir,
		env: params.env
	}));
}
function mergeSecretsRuntimeEnv(env) {
	const merged = { ...env ?? process.env };
	for (const key of RUNTIME_PATH_ENV_KEYS) {
		if (merged[key] !== void 0) continue;
		const processValue = process.env[key];
		if (processValue !== void 0) merged[key] = processValue;
	}
	return merged;
}
function hasConfiguredPluginEntries(config) {
	const entries = config.plugins?.entries;
	return !!entries && typeof entries === "object" && !Array.isArray(entries) && Object.keys(entries).length > 0;
}
function hasConfiguredChannelEntries(config) {
	const channels = config.channels;
	return !!channels && typeof channels === "object" && !Array.isArray(channels) && Object.keys(channels).some((channelId) => channelId !== "defaults");
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
async function prepareSecretsRuntimeSnapshot(params) {
	const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
	const sourceConfig = structuredClone(params.config);
	const resolvedConfig = structuredClone(params.config);
	const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
	let authStores = [];
	const fastPathLoadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreWithoutExternalProfiles;
	const candidateDirs = params.agentDirs?.length ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))] : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
	if (includeAuthStoreRefs) for (const agentDir of candidateDirs) authStores.push({
		agentDir,
		store: structuredClone(fastPathLoadAuthStore(agentDir))
	});
	if (canUseSecretsRuntimeFastPath({
		sourceConfig,
		authStores
	})) {
		const snapshot = {
			sourceConfig,
			config: resolvedConfig,
			authStores,
			warnings: [],
			webTools: createEmptyRuntimeWebToolsMetadata()
		};
		preparedSnapshotRefreshContext.set(snapshot, {
			env: runtimeEnv,
			explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
			loadAuthStore: fastPathLoadAuthStore,
			loadablePluginOrigins: params.loadablePluginOrigins ?? /* @__PURE__ */ new Map()
		});
		return snapshot;
	}
	const { applyResolvedAssignments, collectAuthStoreAssignments, collectConfigAssignments, createResolverContext, resolveRuntimeWebTools, resolveSecretRefValues } = await loadRuntimePrepareHelpers();
	const loadablePluginOrigins = params.loadablePluginOrigins ?? (hasConfiguredPluginEntries(sourceConfig) || hasConfiguredChannelEntries(sourceConfig) ? await resolveLoadablePluginOrigins({
		config: sourceConfig,
		env: runtimeEnv
	}) : /* @__PURE__ */ new Map());
	const context = createResolverContext({
		sourceConfig,
		env: runtimeEnv
	});
	collectConfigAssignments({
		config: resolvedConfig,
		context,
		loadablePluginOrigins
	});
	if (includeAuthStoreRefs) {
		const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
		if (!params.loadAuthStore) authStores = candidateDirs.map((agentDir) => ({
			agentDir,
			store: structuredClone(loadAuthStore(agentDir))
		}));
		for (const entry of authStores) collectAuthStoreAssignments({
			store: entry.store,
			context,
			agentDir: entry.agentDir
		});
	}
	if (context.assignments.length > 0) {
		const resolved = await resolveSecretRefValues(context.assignments.map((assignment) => assignment.ref), {
			config: sourceConfig,
			env: context.env,
			cache: context.cache
		});
		applyResolvedAssignments({
			assignments: context.assignments,
			resolved
		});
	}
	const snapshot = {
		sourceConfig,
		config: resolvedConfig,
		authStores,
		warnings: context.warnings,
		webTools: await resolveRuntimeWebTools({
			sourceConfig,
			resolvedConfig,
			context
		})
	};
	preparedSnapshotRefreshContext.set(snapshot, {
		env: runtimeEnv,
		explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
		loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
		loadablePluginOrigins
	});
	return snapshot;
}
function activateSecretsRuntimeSnapshot(snapshot) {
	const next = cloneSnapshot(snapshot);
	const refreshContext = preparedSnapshotRefreshContext.get(snapshot) ?? activeRefreshContext ?? {
		env: { ...process.env },
		explicitAgentDirs: null,
		loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
		loadablePluginOrigins: /* @__PURE__ */ new Map()
	};
	setRuntimeConfigSnapshot(next.config, next.sourceConfig);
	replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
	activeSnapshot = next;
	activeRefreshContext = cloneRefreshContext(refreshContext);
	setActiveRuntimeWebToolsMetadata(next.webTools);
	setRuntimeConfigSnapshotRefreshHandler({ refresh: async ({ sourceConfig }) => {
		if (!activeSnapshot || !activeRefreshContext) return false;
		activateSecretsRuntimeSnapshot(await prepareSecretsRuntimeSnapshot({
			config: sourceConfig,
			env: activeRefreshContext.env,
			agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
			loadAuthStore: activeRefreshContext.loadAuthStore,
			loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins
		}));
		return true;
	} });
}
function getActiveSecretsRuntimeSnapshot() {
	if (!activeSnapshot) return null;
	const snapshot = cloneSnapshot(activeSnapshot);
	if (activeRefreshContext) preparedSnapshotRefreshContext.set(snapshot, cloneRefreshContext(activeRefreshContext));
	return snapshot;
}
function getActiveRuntimeWebToolsMetadata() {
	return getActiveRuntimeWebToolsMetadata$1();
}
function clearSecretsRuntimeSnapshot() {
	clearActiveSecretsRuntimeState();
}
//#endregion
export { prepareSecretsRuntimeSnapshot as a, getActiveSecretsRuntimeSnapshot as i, clearSecretsRuntimeSnapshot as n, getActiveRuntimeWebToolsMetadata as r, activateSecretsRuntimeSnapshot as t };
