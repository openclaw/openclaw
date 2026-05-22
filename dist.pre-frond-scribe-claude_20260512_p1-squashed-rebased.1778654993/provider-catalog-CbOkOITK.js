import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CzZiaLF-.js";
import { t as modelCatalog } from "./openclaw.plugin-CnxQl_I5.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
