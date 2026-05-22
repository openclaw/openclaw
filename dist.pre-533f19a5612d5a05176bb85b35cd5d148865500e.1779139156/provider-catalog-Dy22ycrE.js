import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CO8moCmL.js";
import { t as modelCatalog } from "./openclaw.plugin-Bxuw0Mjn.js";
//#region extensions/volcengine/provider-catalog.ts
function buildDoubaoProvider() {
	return buildManifestModelProviderConfig({
		providerId: "volcengine",
		catalog: modelCatalog.providers.volcengine
	});
}
function buildDoubaoCodingProvider() {
	return buildManifestModelProviderConfig({
		providerId: "volcengine-plan",
		catalog: modelCatalog.providers["volcengine-plan"]
	});
}
//#endregion
export { buildDoubaoProvider as n, buildDoubaoCodingProvider as t };
