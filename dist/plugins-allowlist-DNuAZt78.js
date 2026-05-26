//#region src/config/plugins-allowlist.ts
function ensurePluginAllowlisted(cfg, pluginId) {
	const allow = cfg.plugins?.allow;
	if (!Array.isArray(allow) || allow.includes(pluginId)) return cfg;
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			allow: [...allow, pluginId]
		}
	};
}
//#endregion
export { ensurePluginAllowlisted as t };
