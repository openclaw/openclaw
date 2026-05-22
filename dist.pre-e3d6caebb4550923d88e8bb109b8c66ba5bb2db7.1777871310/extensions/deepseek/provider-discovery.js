import { t as buildDeepSeekProvider } from "../../provider-catalog-DBhPV2YX.js";
//#region extensions/deepseek/provider-discovery.ts
const deepSeekProviderDiscovery = {
	id: "deepseek",
	label: "DeepSeek",
	docsPath: "/providers/deepseek",
	auth: [],
	staticCatalog: {
		order: "simple",
		run: async () => ({ provider: buildDeepSeekProvider() })
	}
};
//#endregion
export { deepSeekProviderDiscovery as default };
