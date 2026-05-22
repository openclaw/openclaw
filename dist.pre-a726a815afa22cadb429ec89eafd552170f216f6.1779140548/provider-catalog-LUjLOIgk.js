import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Dv7tLTgy.js";
import { t as modelCatalog } from "./openclaw.plugin-fjF4GpTt.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
