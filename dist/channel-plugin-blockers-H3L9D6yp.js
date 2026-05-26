import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { l as resolveEffectivePluginActivationState, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-CgH_ZSlH.js";
import { h as resolveConfiguredChannelPresencePolicy, p as listExplicitConfiguredChannelIdsForConfig } from "./channel-plugin-ids-nB-ga3MN.js";
//#region src/commands/doctor/shared/channel-plugin-blockers.ts
function hasExplicitChannelPluginBlockerConfig(cfg) {
	if (cfg.plugins?.enabled === false) return true;
	const entries = cfg.plugins?.entries;
	if (!entries || typeof entries !== "object") return false;
	return Object.values(entries).some((entry) => {
		return entry && typeof entry === "object" && !Array.isArray(entry) && "enabled" in entry && entry.enabled === false;
	});
}
function scanConfiguredChannelPluginBlockers(cfg, env = process.env) {
	if (!hasExplicitChannelPluginBlockerConfig(cfg)) return [];
	const configuredChannelIds = new Set(listExplicitConfiguredChannelIdsForConfig(cfg).map((channelId) => normalizeOptionalLowercaseString(channelId)).filter((channelId) => Boolean(channelId)));
	if (configuredChannelIds.size === 0) return [];
	const pluginsConfig = normalizePluginsConfig(cfg.plugins);
	const registry = loadPluginManifestRegistryForPluginRegistry({
		config: cfg,
		env,
		includeDisabled: true
	});
	const activeConfiguredChannelIds = new Set(resolveConfiguredChannelPresencePolicy({
		config: cfg,
		env,
		includePersistedAuthState: false,
		manifestRecords: registry.plugins
	}).filter((entry) => entry.effective).map((entry) => entry.channelId));
	const hits = [];
	for (const plugin of registry.plugins) {
		if (plugin.channels.length === 0) continue;
		const activationState = resolveEffectivePluginActivationState({
			id: plugin.id,
			origin: plugin.origin,
			config: pluginsConfig,
			rootConfig: cfg,
			enabledByDefault: plugin.enabledByDefault
		});
		if (activationState.activated || !activationState.reason || activationState.reason !== "disabled in config" && activationState.reason !== "plugins disabled") continue;
		for (const rawChannelId of plugin.channels) {
			const channelId = normalizeOptionalLowercaseString(rawChannelId);
			if (!channelId) continue;
			if (!configuredChannelIds.has(channelId)) continue;
			if (activeConfiguredChannelIds.has(channelId)) continue;
			hits.push({
				channelId,
				pluginId: plugin.id,
				reason: activationState.reason
			});
		}
	}
	return hits;
}
function formatReason(hit) {
	if (hit.reason === "disabled in config") return `plugin "${sanitizeForLog(hit.pluginId)}" is disabled by plugins.entries.${sanitizeForLog(hit.pluginId)}.enabled=false.`;
	if (hit.reason === "plugins disabled") return `plugins.enabled=false blocks channel plugins globally.`;
	return `plugin "${sanitizeForLog(hit.pluginId)}" is not loadable (${sanitizeForLog(hit.reason)}).`;
}
function collectConfiguredChannelPluginBlockerWarnings(hits) {
	return hits.map((hit) => `- channels.${sanitizeForLog(hit.channelId)}: channel is configured, but ${formatReason(hit)} Fix plugin enablement before relying on setup guidance for this channel.`);
}
function isWarningBlockedByChannelPlugin(warning, hits) {
	return hits.some((hit) => {
		const prefix = `channels.${sanitizeForLog(hit.channelId)}`;
		return warning.includes(`${prefix}:`) || warning.includes(`${prefix}.`);
	});
}
//#endregion
export { collectConfiguredChannelPluginBlockerWarnings, isWarningBlockedByChannelPlugin, scanConfiguredChannelPluginBlockers };
