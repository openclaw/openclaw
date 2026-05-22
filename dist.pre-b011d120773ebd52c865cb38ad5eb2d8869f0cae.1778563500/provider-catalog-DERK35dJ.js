import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Db90GZEt.js";
import { t as modelCatalog } from "./openclaw.plugin-MCRZczXh.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
