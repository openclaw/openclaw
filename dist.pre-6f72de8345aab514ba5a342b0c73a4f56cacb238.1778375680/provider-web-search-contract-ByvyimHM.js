import { t as enablePluginInConfig } from "./provider-enable-config-D90R6Jz6.js";
import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-DNbiHfa3.js";
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
