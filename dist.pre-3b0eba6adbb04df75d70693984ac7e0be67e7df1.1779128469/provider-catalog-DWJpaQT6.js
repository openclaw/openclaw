import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-DMXBCanM.js";
import { t as modelCatalog } from "./openclaw.plugin-B5puy819.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
