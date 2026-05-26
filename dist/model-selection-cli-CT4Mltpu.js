import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { r as resolveAgentModelFallbackValues } from "./model-input-B9p-bobB.js";
import { r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { d as isInstalledPluginEnabled } from "./installed-plugin-index-store-DetkjvO9.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-DHmOxzz2.js";
import { n as getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state-Br1Hd8D7.js";
import { t as getActiveRuntimePluginRegistry } from "./active-runtime-registry-CToOMaT0.js";
import { i as buildModelAliasIndex, o as getModelRefStatusWithFallbackModels, p as resolveAllowedModelRefFromAliasIndex } from "./model-selection-shared-Dh1KrVmr.js";
import "./model-selection-normalize-B4tdZ1L4.js";
import { createRequire } from "node:module";
//#region src/agents/model-selection-resolve.ts
function resolveDefaultFallbackModels(cfg) {
	return resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
}
function getModelRefStatus(params) {
	const { cfg, catalog, ref, defaultProvider, defaultModel } = params;
	return getModelRefStatusWithFallbackModels({
		cfg,
		catalog,
		ref,
		defaultProvider,
		defaultModel,
		fallbackModels: resolveDefaultFallbackModels(cfg)
	});
}
function resolveAllowedModelRef(params) {
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider
	});
	return resolveAllowedModelRefFromAliasIndex({
		cfg: params.cfg,
		raw: params.raw,
		defaultProvider: params.defaultProvider,
		aliasIndex,
		getStatus: (ref) => getModelRefStatus({
			cfg: params.cfg,
			catalog: params.catalog,
			ref,
			defaultProvider: params.defaultProvider,
			defaultModel: params.defaultModel
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
