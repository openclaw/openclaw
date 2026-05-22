import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DMXBCanM.js";
import { t as modelCatalog } from "./openclaw.plugin-NXdLQvs2.js";
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
