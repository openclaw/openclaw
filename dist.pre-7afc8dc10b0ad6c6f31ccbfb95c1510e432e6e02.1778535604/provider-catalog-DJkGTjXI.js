import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-C1Bm1vy2.js";
import { t as modelCatalog } from "./openclaw.plugin-AquXW9UA.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
