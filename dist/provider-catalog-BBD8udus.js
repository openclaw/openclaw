import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-4kkagm5f.js";
import { t as modelCatalog } from "./openclaw.plugin-BAfFPp8s.js";
//#region extensions/byteplus/provider-catalog.ts
function buildBytePlusProvider() {
	return buildManifestModelProviderConfig({
		providerId: "byteplus",
		catalog: modelCatalog.providers.byteplus
	});
}
function buildBytePlusCodingProvider() {
	return buildManifestModelProviderConfig({
		providerId: "byteplus-plan",
		catalog: modelCatalog.providers["byteplus-plan"]
	});
}
//#endregion
export { buildBytePlusProvider as n, buildBytePlusCodingProvider as t };
