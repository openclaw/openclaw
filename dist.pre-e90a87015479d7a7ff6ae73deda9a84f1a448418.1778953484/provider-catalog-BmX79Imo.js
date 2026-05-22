import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CZwfu6ul.js";
import { t as modelCatalog } from "./openclaw.plugin-7I6gY2ul.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
