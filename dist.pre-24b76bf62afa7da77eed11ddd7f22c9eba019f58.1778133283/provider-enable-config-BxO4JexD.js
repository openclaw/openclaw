import { t as ensurePluginAllowlisted } from "./plugins-allowlist-Dz3tOOW8.js";
//#region src/plugin-sdk/provider-enable-config.ts
/**
* Provider contract surfaces only ever enable provider plugins, so they do not
* need the built-in channel normalization path from plugins/enable.ts.
*/
function enablePluginInConfig(cfg, pluginId) {
	if (cfg.plugins?.enabled === false) return {
		config: cfg,
		enabled: false,
		reason: "plugins disabled"
	};
	if (cfg.plugins?.deny?.includes(pluginId)) return {
		config: cfg,
		enabled: false,
		reason: "blocked by denylist"
	};
	let next = {
		...cfg,
		plugins: {
			...cfg.plugins,
			entries: {
				...cfg.plugins?.entries,
				[pluginId]: {
					...cfg.plugins?.entries?.[pluginId],
					enabled: true
				}
			}
		}
	};
	next = ensurePluginAllowlisted(next, pluginId);
	return {
		config: next,
		enabled: true
	};
}
//#endregion
export { enablePluginInConfig as t };
