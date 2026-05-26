import { r as normalizeChatChannelId } from "./ids-BE_yccbC.js";
import { t as setPluginEnabledInConfig } from "./toggle-config-DID_OgqP.js";
//#region src/plugins/enable.ts
function enablePluginInConfig(cfg, pluginId, options = {}) {
	const resolvedId = normalizeChatChannelId(pluginId) ?? pluginId;
	if (cfg.plugins?.enabled === false) return {
		config: cfg,
		enabled: false,
		pluginId: resolvedId,
		reason: "plugins disabled"
	};
	if (cfg.plugins?.deny?.includes(pluginId) || cfg.plugins?.deny?.includes(resolvedId)) return {
		config: cfg,
		enabled: false,
		pluginId: resolvedId,
		reason: "blocked by denylist"
	};
	const allow = cfg.plugins?.allow;
	if (Array.isArray(allow) && allow.length > 0 && !allow.includes(pluginId) && !allow.includes(resolvedId)) return {
		config: cfg,
		enabled: false,
		pluginId: resolvedId,
		reason: "blocked by allowlist"
	};
	return {
		config: setPluginEnabledInConfig(cfg, resolvedId, true, options),
		enabled: true,
		pluginId: resolvedId
	};
}
//#endregion
export { enablePluginInConfig as t };
