import { t as buildTokenHubProvider } from "../../provider-catalog-BJVFoaeo.js";
//#region extensions/tencent/provider-discovery.ts
const tencentProviderDiscovery = {
	id: "tencent-tokenhub",
	label: "Tencent TokenHub",
	docsPath: "/providers/models",
	auth: [],
	staticCatalog: {
		order: "simple",
		run: async () => ({ provider: buildTokenHubProvider() })
	}
};
//#endregion
export { tencentProviderDiscovery as default };
