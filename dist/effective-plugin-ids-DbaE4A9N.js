import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as defaultSlotIdForKey } from "./slots-DT22cOei.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { i as passesManifestOwnerBasePolicy } from "./manifest-owner-policy-DqV-lgQl.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { i as listPotentialConfiguredChannelIds, r as listExplicitlyDisabledChannelIdsForConfig } from "./config-presence-DiJ4UoDg.js";
import { m as resolveConfiguredChannelPluginIds, p as listExplicitConfiguredChannelIdsForConfig, t as loadGatewayStartupPluginPlan } from "./channel-plugin-ids-nB-ga3MN.js";
//#region src/plugins/effective-plugin-ids.ts
function collectConfiguredChannelIds(config, activationSourceConfig, env) {
	const disabled = new Set([...listExplicitlyDisabledChannelIdsForConfig(config), ...listExplicitlyDisabledChannelIdsForConfig(activationSourceConfig)]);
	return [...new Set([...listPotentialConfiguredChannelIds(config, env, { includePersistedAuthState: false }), ...listExplicitConfiguredChannelIdsForConfig(activationSourceConfig)])].map((channelId) => normalizeOptionalLowercaseString(channelId)).filter((channelId) => {
		if (!channelId) return false;
		return !disabled.has(channelId);
	}).toSorted((left, right) => left.localeCompare(right));
}
function collectBundledChannelOwnerPluginIds(params) {
	const plugins = normalizePluginsConfig(params.config.plugins);
	const channelIds = new Set(params.channelIds.map((channelId) => normalizeOptionalLowercaseString(channelId)).filter((channelId) => Boolean(channelId)));
	if (channelIds.size === 0) return [];
	const env = params.bundledPluginsDir ? {
		...params.env,
		OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir,
		...params.env.VITEST || process.env.VITEST ? { OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1" } : {}
	} : params.env;
	const snapshot = loadManifestMetadataSnapshot({
		config: params.config,
		env,
		workspaceDir: params.workspaceDir
	});
	const pluginIds = /* @__PURE__ */ new Set();
	for (const plugin of snapshot.plugins) {
		if (plugin.origin !== "bundled") continue;
		if (plugin.channels.some((channelId) => channelIds.has(normalizeOptionalLowercaseString(channelId) ?? ""))) {
			const pluginId = normalizeOptionalLowercaseString(plugin.id);
			if (pluginId && passesManifestOwnerBasePolicy({
				plugin: { id: pluginId },
				normalizedConfig: plugins,
				allowRestrictiveAllowlistBypass: true
			})) pluginIds.add(pluginId);
		}
	}
	return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
function collectExplicitEffectivePluginIds(config) {
	const plugins = normalizePluginsConfig(config.plugins);
	if (!plugins.enabled) return [];
	const ids = new Set(plugins.allow);
	for (const [pluginId, entry] of Object.entries(plugins.entries)) if (entry?.enabled === true && (plugins.allow.length === 0 || plugins.allow.includes(pluginId))) ids.add(pluginId);
	for (const pluginId of plugins.deny) ids.delete(pluginId);
	for (const [pluginId, entry] of Object.entries(plugins.entries)) if (entry?.enabled === false) ids.delete(pluginId);
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
function collectSelectedContextEnginePluginIds(config) {
	const plugins = normalizePluginsConfig(config.plugins);
	if (!plugins.enabled) return [];
	const pluginId = plugins.slots.contextEngine;
	if (!pluginId || pluginId === defaultSlotIdForKey("contextEngine")) return [];
	if (plugins.deny.includes(pluginId)) return [];
	if (plugins.entries[pluginId]?.enabled === false) return [];
	return [pluginId];
}
function resolveEffectivePluginIds(params) {
	const effectiveConfig = applyPluginAutoEnable({
		config: params.config,
		env: params.env
	}).config;
	const ids = new Set(collectExplicitEffectivePluginIds(effectiveConfig));
	for (const pluginId of collectSelectedContextEnginePluginIds(effectiveConfig)) ids.add(pluginId);
	const configuredChannelIds = collectConfiguredChannelIds(effectiveConfig, params.config, params.env);
	for (const pluginId of resolveConfiguredChannelPluginIds({
		config: effectiveConfig,
		activationSourceConfig: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	})) ids.add(pluginId);
	for (const pluginId of collectBundledChannelOwnerPluginIds({
		config: effectiveConfig,
		channelIds: configuredChannelIds,
		env: params.env,
		workspaceDir: params.workspaceDir,
		...params.bundledPluginsDir ? { bundledPluginsDir: params.bundledPluginsDir } : {}
	})) ids.add(pluginId);
	for (const pluginId of loadGatewayStartupPluginPlan({
		config: effectiveConfig,
		activationSourceConfig: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}).pluginIds) ids.add(pluginId);
	return [...ids].toSorted((left, right) => left.localeCompare(right));
}
//#endregion
export { resolveEffectivePluginIds as t };
