import { n as buildBytePlusProvider, t as buildBytePlusCodingProvider } from "../../provider-catalog-DF5v1UBj.js";
//#region extensions/byteplus/provider-discovery.ts
const bytePlusProviderDiscovery = [{
	id: "byteplus",
	label: "BytePlus",
	docsPath: "/providers/models",
	auth: [],
	staticCatalog: {
		order: "simple",
		run: async () => ({ provider: buildBytePlusProvider() })
	}
}, {
	id: "byteplus-plan",
	label: "BytePlus Plan",
	docsPath: "/providers/models",
	auth: [],
	staticCatalog: {
		order: "simple",
		run: async () => ({ provider: buildBytePlusCodingProvider() })
	}
}];
//#endregion
export { bytePlusProviderDiscovery as default };
