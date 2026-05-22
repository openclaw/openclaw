import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BaaxfOrS.js";
import { t as modelCatalog } from "./openclaw.plugin-BehnQmqL.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
