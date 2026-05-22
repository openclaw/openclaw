import { o as normalizePluginId } from "./config-state-wKtsQXM5.js";
import { n as hasExplicitPluginConfig } from "./manifest-registry-BiAsJcRZ.js";
//#region src/plugins/bundled-compat.ts
function withBundledPluginAllowlistCompat(params) {
	if (params.config?.plugins?.bundledDiscovery !== "compat") return params.config;
	const allow = params.config?.plugins?.allow;
	if (!Array.isArray(allow) || allow.length === 0) return params.config;
	const allowSet = new Set(allow.map((entry) => entry.trim()).filter(Boolean));
	let changed = false;
	for (const pluginId of params.pluginIds) if (!allowSet.has(pluginId)) {
		allowSet.add(pluginId);
		changed = true;
	}
	if (!changed) return params.config;
	return {
		...params.config,
		plugins: {
			...params.config?.plugins,
			allow: [...allowSet]
		}
	};
}
function withBundledPluginEnablementCompat(params) {
	const existingEntries = params.config?.plugins?.entries ?? {};
	const forcePluginsEnabled = params.config?.plugins?.enabled === false;
	const useCompatDiscovery = params.config?.plugins?.bundledDiscovery === "compat";
	const allow = params.config?.plugins?.allow;
	const allowSet = !useCompatDiscovery && Array.isArray(allow) && allow.length > 0 ? new Set(allow.map((pluginId) => normalizePluginId(pluginId)).filter(Boolean)) : void 0;
	let hasEligiblePlugin = false;
	let changed = false;
	const nextEntries = { ...existingEntries };
	for (const pluginId of params.pluginIds) {
		if (allowSet && !allowSet.has(pluginId)) continue;
		hasEligiblePlugin = true;
		if (existingEntries[pluginId] !== void 0) continue;
		nextEntries[pluginId] = { enabled: true };
		changed = true;
	}
	if (!changed) {
		if (!forcePluginsEnabled || !hasEligiblePlugin) return params.config;
	}
	return {
		...params.config,
		plugins: {
			...params.config?.plugins,
			...forcePluginsEnabled ? { enabled: true } : {},
			entries: {
				...existingEntries,
				...nextEntries
			}
		}
	};
}
function withBundledPluginVitestCompat(params) {
	const env = params.env ?? process.env;
	if (!Boolean(env.VITEST) || hasExplicitPluginConfig(params.config?.plugins) || params.pluginIds.length === 0) return params.config;
	const entries = Object.fromEntries(params.pluginIds.map((pluginId) => [pluginId, { enabled: true }]));
	return {
		...params.config,
		plugins: {
			...params.config?.plugins,
			enabled: true,
			allow: [...params.pluginIds],
			entries: {
				...entries,
				...params.config?.plugins?.entries
			},
			slots: {
				...params.config?.plugins?.slots,
				memory: "none"
			}
		}
	};
}
//#endregion
export { withBundledPluginEnablementCompat as n, withBundledPluginVitestCompat as r, withBundledPluginAllowlistCompat as t };
