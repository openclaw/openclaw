import { n as buildDoubaoProvider, t as buildDoubaoCodingProvider } from "../../provider-catalog-wn341Uo6.js";
//#region extensions/volcengine/provider-discovery.ts
const volcengineProviderDiscovery = [{
	id: "volcengine",
	label: "Volcengine",
	docsPath: "/providers/models",
	auth: [],
	staticCatalog: {
		order: "simple",
		run: async () => ({ provider: buildDoubaoProvider() })
	}
}, {
	id: "volcengine-plan",
	label: "Volcengine Plan",
	docsPath: "/providers/models",
	auth: [],
	staticCatalog: {
		order: "simple",
		run: async () => ({ provider: buildDoubaoCodingProvider() })
	}
}];
//#endregion
export { volcengineProviderDiscovery as default };
