import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-ChW9XXsQ.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { d as isInstalledPluginEnabled } from "./installed-plugin-index-store-C1Oen9wR.js";
import { v as getCurrentPluginMetadataSnapshot } from "./plugin-registry-CgH_ZSlH.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-DRIYGASz.js";
import { t as getActiveRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { i as buildModelAliasIndex, m as resolveAllowedModelRefFromAliasIndex, o as getModelRefStatusWithFallbackModels } from "./model-selection-shared-ClxdEp4X.js";
import "./model-selection-normalize-CBfQo-Fd.js";
import { createRequire } from "node:module";
//#region src/agents/model-selection-resolve.ts
function resolveDefaultFallbackModels(cfg) {
	return resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
}
function getModelRefStatus(params) {
	const { cfg, catalog, ref, defaultProvider, defaultModel, manifestPlugins } = params;
	return getModelRefStatusWithFallbackModels({
		cfg,
		catalog,
		ref,
		defaultProvider,
		defaultModel,
		fallbackModels: resolveDefaultFallbackModels(cfg),
		manifestPlugins
	});
}
function resolveAllowedModelRef(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider,
		manifestPlugins: params.manifestPlugins
	});
	return resolveAllowedModelRefFromAliasIndex({
		cfg: params.cfg,
		raw: params.raw,
		defaultProvider: params.defaultProvider,
		aliasIndex,
		manifestPlugins: params.manifestPlugins,
		getStatus: (ref) => getModelRefStatus({
			cfg: params.cfg,
			catalog: params.catalog,
			ref,
			defaultProvider: params.defaultProvider,
			defaultModel: params.defaultModel,
			manifestPlugins: params.manifestPlugins
		})
	});
}
//#endregion
//#region src/plugins/cli-backends.runtime.ts
function resolveRuntimeCliBackends() {
	return (getActiveRuntimePluginRegistry()?.cliBackends ?? []).map((entry) => Object.assign({}, entry.backend, { pluginId: entry.pluginId }));
}
//#endregion
//#region src/plugins/setup-registry.runtime.ts
const require = createRequire(import.meta.url);
const SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./setup-registry.js", "./setup-registry.ts"];
let setupRegistryRuntimeModule;
let cachedBundledSetupCliBackends;
function resolveMetadataSnapshotForSetupCliBackends(params = {}) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
	const current = getCurrentPluginMetadataSnapshot({
		config: params.config,
		env,
		workspaceDir
	});
	if (current) return {
		snapshot: current,
		cacheable: true
	};
	return {
		snapshot: loadPluginMetadataSnapshot({
			config: params.config ?? {},
			env,
			workspaceDir
		}),
		cacheable: false
	};
}
function resolveBundledSetupCliBackends(params = {}) {
	const { snapshot, cacheable } = resolveMetadataSnapshotForSetupCliBackends(params);
	const configFingerprint = snapshot.configFingerprint;
	if (cacheable && configFingerprint && cachedBundledSetupCliBackends?.configFingerprint === configFingerprint) return cachedBundledSetupCliBackends.entries;
	const entries = snapshot.plugins.flatMap((plugin) => {
		if (plugin.origin !== "bundled" || !isInstalledPluginEnabled(snapshot.index, plugin.id)) return [];
		return [...plugin.cliBackends, ...plugin.setup?.cliBackends ?? []].map((backendId) => ({
			pluginId: plugin.id,
			backend: { id: backendId }
		}));
	});
	if (cacheable && configFingerprint) cachedBundledSetupCliBackends = {
		configFingerprint,
		entries
	};
	return entries;
}
function loadSetupRegistryRuntime() {
	if (setupRegistryRuntimeModule !== void 0) return setupRegistryRuntimeModule;
	for (const candidate of SETUP_REGISTRY_RUNTIME_CANDIDATES) try {
		setupRegistryRuntimeModule = require(candidate);
		return setupRegistryRuntimeModule;
	} catch {}
	setupRegistryRuntimeModule = null;
	return null;
}
function resolvePluginSetupCliBackendRuntime(params) {
	const normalized = normalizeProviderId(params.backend);
	const runtime = loadSetupRegistryRuntime();
	if (runtime !== null) return runtime.resolvePluginSetupCliBackend(params);
	return resolveBundledSetupCliBackends(params).find((entry) => normalizeProviderId(entry.backend.id) === normalized);
}
//#endregion
//#region src/agents/model-selection-cli.ts
function isCliProvider(provider, cfg) {
	const normalized = normalizeProviderId(provider);
	const backends = cfg?.agents?.defaults?.cliBackends ?? {};
	if (Object.keys(backends).some((key) => normalizeProviderId(key) === normalized)) return true;
	if (resolveRuntimeCliBackends().some((backend) => normalizeProviderId(backend.id) === normalized)) return true;
	if (resolvePluginSetupCliBackendRuntime({
		backend: normalized,
		config: cfg
	})) return true;
	return false;
}
//#endregion
export { resolveAllowedModelRef as i, resolveRuntimeCliBackends as n, getModelRefStatus as r, isCliProvider as t };
