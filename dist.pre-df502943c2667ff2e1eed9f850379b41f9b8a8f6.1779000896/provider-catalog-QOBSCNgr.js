import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-B_DVwuDx.js";
import { t as modelCatalog } from "./openclaw.plugin-UDaZZfGJ.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
