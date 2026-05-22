import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { a as createEffectiveEnableStateResolver, c as resolvePluginActivationDecisionShared, i as normalizePluginsConfigWithResolver, l as toPluginActivationState, o as createPluginEnableStateResolver, r as isBundledChannelEnabledByChannelConfig$1, s as resolveMemorySlotDecisionShared, t as hasExplicitPluginConfig$1 } from "./config-normalization-shared-DamsNnJD.js";
import { n as defaultSlotIdForKey } from "./slots-CQk-Ab1S.js";
//#region src/plugins/config-state.ts
const BUILT_IN_PLUGIN_ALIAS_FALLBACKS = [
	["openai-codex", "openai"],
	["google-gemini-cli", "google"],
	["minimax-portal", "minimax"],
	["minimax-portal-auth", "minimax"]
];
const BUILT_IN_PLUGIN_ALIAS_LOOKUP = new Map([...BUILT_IN_PLUGIN_ALIAS_FALLBACKS, ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS.map(([, pluginId]) => [pluginId, pluginId])]);
function getBundledPluginAliasLookup() {
	const lookup = /* @__PURE__ */ new Map();
	for (const [alias, pluginId] of BUILT_IN_PLUGIN_ALIAS_FALLBACKS) lookup.set(alias, pluginId);
	return lookup;
}
function normalizePluginIdWithLookup(id, getAliasLookup) {
	const trimmed = normalizeOptionalString(id) ?? "";
	const normalized = normalizeOptionalLowercaseString(trimmed) ?? "";
	const builtInAlias = BUILT_IN_PLUGIN_ALIAS_LOOKUP.get(normalized);
	if (builtInAlias) return builtInAlias;
	return getAliasLookup().get(normalized) ?? trimmed;
}
function createScopedPluginIdNormalizer() {
	let lookup;
	return (id) => normalizePluginIdWithLookup(id, () => {
		lookup ??= getBundledPluginAliasLookup();
		return lookup;
	});
}
function normalizePluginId(id) {
	return normalizePluginIdWithLookup(id, getBundledPluginAliasLookup);
}
const normalizePluginsConfig = (config) => {
	return normalizePluginsConfigWithResolver(config, createScopedPluginIdNormalizer());
};
function createPluginActivationSource(params) {
	return {
		plugins: params.plugins ?? normalizePluginsConfig(params.config?.plugins),
		rootConfig: params.config
	};
}
const hasExplicitMemorySlot = (plugins) => Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));
const hasExplicitMemoryEntry = (plugins) => Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, defaultSlotIdForKey("memory")));
const hasExplicitPluginConfig = (plugins) => hasExplicitPluginConfig$1(plugins);
function applyTestPluginDefaults(cfg, env = process.env) {
	if (!env.VITEST) return cfg;
	const plugins = cfg.plugins;
	if (hasExplicitPluginConfig(plugins)) {
		if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) return cfg;
		return {
			...cfg,
			plugins: {
				...plugins,
				slots: {
					...plugins?.slots,
					memory: "none"
				}
			}
		};
	}
	return {
		...cfg,
		plugins: {
			...plugins,
			enabled: false,
			slots: {
				...plugins?.slots,
				memory: "none"
			}
		}
	};
}
function isTestDefaultMemorySlotDisabled(cfg, env = process.env) {
	if (!env.VITEST) return false;
	const plugins = cfg.plugins;
	if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) return false;
	return true;
}
function resolvePluginActivationState(params) {
	return toPluginActivationState(resolvePluginActivationDecisionShared({
		...params,
		activationSource: params.activationSource ?? createPluginActivationSource({
			config: params.rootConfig,
			plugins: params.config
		}),
		allowBundledChannelExplicitBypassesAllowlist: true,
		isBundledChannelEnabledByChannelConfig
	}));
}
const resolveEnableState = createPluginEnableStateResolver(resolvePluginActivationState);
const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfig$1;
const resolveEffectiveEnableState = createEffectiveEnableStateResolver(resolveEffectivePluginActivationState);
function resolveEffectivePluginActivationState(params) {
	return resolvePluginActivationState(params);
}
function resolveMemorySlotDecision(params) {
	return resolveMemorySlotDecisionShared(params);
}
//#endregion
export { isTestDefaultMemorySlotDisabled as a, resolveEffectiveEnableState as c, resolveMemorySlotDecision as d, resolvePluginActivationState as f, isBundledChannelEnabledByChannelConfig as i, resolveEffectivePluginActivationState as l, createPluginActivationSource as n, normalizePluginId as o, hasExplicitPluginConfig as r, normalizePluginsConfig as s, applyTestPluginDefaults as t, resolveEnableState as u };
