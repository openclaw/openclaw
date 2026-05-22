import { i as normalizeModelCatalogProviderId } from "./normalize-SvyUV8HY.js";
import { E as planProviderIndexModelCatalogRows, k as loadOpenClawProviderIndex } from "./discovery-CVL9-KJt.js";
import { c as resolveEffectiveEnableState, s as normalizePluginsConfig } from "./config-state-wKtsQXM5.js";
//#region src/commands/models/list.provider-index-catalog.ts
function loadProviderIndexCatalogRowsForList(params) {
	const providerFilter = params.providerFilter ? normalizeModelCatalogProviderId(params.providerFilter) : void 0;
	return planProviderIndexModelCatalogRows({
		index: loadOpenClawProviderIndex(),
		...providerFilter ? { providerFilter } : {}
	}).entries.filter((entry) => resolveEffectiveEnableState({
		id: entry.pluginId,
		origin: "bundled",
		config: normalizePluginsConfig(params.cfg.plugins),
		rootConfig: params.cfg,
		enabledByDefault: true
	}).enabled).flatMap((entry) => entry.rows);
}
//#endregion
export { loadProviderIndexCatalogRowsForList };
