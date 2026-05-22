import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-NZuRh3rG.js";
import { t as modelCatalog } from "./openclaw.plugin-Bl0BoO_H.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
