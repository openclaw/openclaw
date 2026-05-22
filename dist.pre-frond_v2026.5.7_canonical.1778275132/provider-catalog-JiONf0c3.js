import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CsCNdUte.js";
import { t as modelCatalog } from "./openclaw.plugin-_TwoH5JQ.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
