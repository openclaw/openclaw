import { c as isRecord } from "./utils-D5swhEXt.js";
import { t as discoverOpenClawPlugins } from "./discovery-CVL9-KJt.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-BiAsJcRZ.js";
import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-Cut-MFnk.js";
//#region src/plugins/config-contracts.ts
function normalizePathPattern(pathPattern) {
	return pathPattern.split(".").map((segment) => segment.trim()).filter(Boolean);
}
function appendPathSegment(path, segment) {
	if (!path) return segment;
	return /^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`;
}
function collectPluginConfigContractMatches(params) {
	const pattern = normalizePathPattern(params.pathPattern);
	if (pattern.length === 0) return [];
	let states = [{
		segments: [],
		value: params.root
	}];
	for (const segment of pattern) {
		const nextStates = [];
		for (const state of states) {
			if (segment === "*") {
				if (Array.isArray(state.value)) {
					for (const [index, value] of state.value.entries()) nextStates.push({
						segments: [...state.segments, String(index)],
						value
					});
					continue;
				}
				if (isRecord(state.value)) for (const [key, value] of Object.entries(state.value)) nextStates.push({
					segments: [...state.segments, key],
					value
				});
				continue;
			}
			if (Array.isArray(state.value)) {
				const index = Number.parseInt(segment, 10);
				if (Number.isInteger(index) && index >= 0 && index < state.value.length) nextStates.push({
					segments: [...state.segments, segment],
					value: state.value[index]
				});
				continue;
			}
			if (!isRecord(state.value) || !Object.prototype.hasOwnProperty.call(state.value, segment)) continue;
			nextStates.push({
				segments: [...state.segments, segment],
				value: state.value[segment]
			});
		}
		states = nextStates;
		if (states.length === 0) break;
	}
	return states.map((state) => ({
		path: state.segments.reduce(appendPathSegment, ""),
		value: state.value
	}));
}
function resolvePluginConfigContractsById(params) {
	const matches = /* @__PURE__ */ new Map();
	const pluginIds = [...new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))];
	if (pluginIds.length === 0) return matches;
	const fallbackBundledPluginIds = new Set((params.fallbackBundledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean));
	const bundledContractFallbacks = /* @__PURE__ */ new Map();
	const findBundledConfigContracts = (pluginId) => {
		if (bundledContractFallbacks.has(pluginId)) return bundledContractFallbacks.get(pluginId);
		const discovery = discoverOpenClawPlugins({
			workspaceDir: params.workspaceDir,
			env: params.env
		});
		const registry = loadPluginManifestRegistry({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			candidates: discovery.candidates.filter((candidate) => candidate.origin === "bundled"),
			diagnostics: discovery.diagnostics
		});
		for (const plugin of registry.plugins) bundledContractFallbacks.set(plugin.id, plugin.configContracts);
		if (!bundledContractFallbacks.has(pluginId)) bundledContractFallbacks.set(pluginId, void 0);
		return bundledContractFallbacks.get(pluginId);
	};
	const resolvedPluginOrigins = /* @__PURE__ */ new Map();
	const registry = loadPluginManifestRegistryForPluginRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeDisabled: true
	});
	for (const plugin of registry.plugins) {
		if (!pluginIds.includes(plugin.id)) continue;
		resolvedPluginOrigins.set(plugin.id, plugin.origin);
		if (!plugin.configContracts) continue;
		matches.set(plugin.id, {
			origin: plugin.origin,
			configContracts: plugin.configContracts
		});
	}
	if (params.fallbackToBundledMetadata ?? true) for (const pluginId of pluginIds) {
		const existing = matches.get(pluginId);
		if (existing && (params.fallbackToBundledMetadataForResolvedBundled && existing.origin === "bundled" || fallbackBundledPluginIds.has(pluginId))) {
			const bundledConfigContracts = findBundledConfigContracts(pluginId);
			if (bundledConfigContracts) matches.set(pluginId, {
				origin: fallbackBundledPluginIds.has(pluginId) ? "bundled" : existing.origin,
				configContracts: {
					...bundledConfigContracts,
					...existing.configContracts,
					...bundledConfigContracts.secretInputs ? { secretInputs: bundledConfigContracts.secretInputs } : {}
				}
			});
			continue;
		}
		if (matches.has(pluginId)) continue;
		const resolvedOrigin = resolvedPluginOrigins.get(pluginId);
		if (resolvedOrigin && !(params.fallbackToBundledMetadataForResolvedBundled && resolvedOrigin === "bundled") && !fallbackBundledPluginIds.has(pluginId)) continue;
		const bundledConfigContracts = findBundledConfigContracts(pluginId);
		if (!bundledConfigContracts) continue;
		matches.set(pluginId, {
			origin: "bundled",
			configContracts: bundledConfigContracts
		});
	}
	return matches;
}
//#endregion
export { resolvePluginConfigContractsById as n, collectPluginConfigContractMatches as t };
