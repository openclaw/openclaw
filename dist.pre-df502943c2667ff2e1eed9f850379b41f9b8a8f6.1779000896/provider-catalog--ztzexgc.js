import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-B_DVwuDx.js";
import { t as modelCatalog } from "./openclaw.plugin-DHoptIpz.js";
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
