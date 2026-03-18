import { t as ensurePluginAllowlisted } from "./plugins-allowlist-E4LSkJ7R.js";
import { a as init_registry, l as normalizeChatChannelId } from "./registry-ep1yQ6WN.js";
//#region src/plugins/toggle-config.ts
init_registry();
function setPluginEnabledInConfig(config, pluginId, enabled) {
	const builtInChannelId = normalizeChatChannelId(pluginId);
	const resolvedId = builtInChannelId ?? pluginId;
	const next = {
		...config,
		plugins: {
			...config.plugins,
			entries: {
				...config.plugins?.entries,
				[resolvedId]: {
					...config.plugins?.entries?.[resolvedId],
					enabled
				}
			}
		}
	};
	if (!builtInChannelId) return next;
	const existing = config.channels?.[builtInChannelId];
	const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
	return {
		...next,
		channels: {
			...config.channels,
			[builtInChannelId]: {
				...existingRecord,
				enabled
			}
		}
	};
}
//#endregion
//#region src/plugins/enable.ts
init_registry();
function enablePluginInConfig(cfg, pluginId) {
	const resolvedId = normalizeChatChannelId(pluginId) ?? pluginId;
	if (cfg.plugins?.enabled === false) return {
		config: cfg,
		enabled: false,
		reason: "plugins disabled"
	};
	if (cfg.plugins?.deny?.includes(pluginId) || cfg.plugins?.deny?.includes(resolvedId)) return {
		config: cfg,
		enabled: false,
		reason: "blocked by denylist"
	};
	let next = setPluginEnabledInConfig(cfg, resolvedId, true);
	next = ensurePluginAllowlisted(next, resolvedId);
	return {
		config: next,
		enabled: true
	};
}
//#endregion
export { setPluginEnabledInConfig as n, enablePluginInConfig as t };
