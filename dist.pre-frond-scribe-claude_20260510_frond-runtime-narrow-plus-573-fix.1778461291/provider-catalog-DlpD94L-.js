import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-zGKZvvHe.js";
import { t as modelCatalog } from "./openclaw.plugin-B_RzaBVb.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
