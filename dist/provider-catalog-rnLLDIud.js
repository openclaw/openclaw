import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
import { t as modelCatalog } from "./openclaw.plugin-CzIsD0wt.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
