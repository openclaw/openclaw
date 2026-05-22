import { t as buildDeepSeekProvider } from "../../provider-catalog-Bst3Vrfk.js";
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
