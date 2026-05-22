import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Bqa0paW_.js";
import { t as modelCatalog } from "./openclaw.plugin-DytzhOy2.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
