import { t as enablePluginInConfig } from "./provider-enable-config-_Y2uI0xp.js";
import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-ClpAD_Tw.js";
//#region src/plugin-sdk/provider-web-search-contract.ts
function createWebSearchProviderContractFields(options) {
	const selectionPluginId = options.selectionPluginId;
	return {
		...createBaseWebSearchProviderContractFields(options),
		...selectionPluginId ? { applySelectionConfig: (config) => enablePluginInConfig(config, selectionPluginId).config } : {}
	};
}
//#endregion
export { createWebSearchProviderContractFields as t };
