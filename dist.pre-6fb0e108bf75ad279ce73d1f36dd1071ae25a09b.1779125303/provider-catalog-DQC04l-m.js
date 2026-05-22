import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-fMC-0vbQ.js";
import { t as modelCatalog } from "./openclaw.plugin-Be1HVKyv.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
