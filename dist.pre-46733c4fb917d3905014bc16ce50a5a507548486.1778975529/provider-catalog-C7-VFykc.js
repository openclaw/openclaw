import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-D6Tgn3Fc.js";
import { t as modelCatalog } from "./openclaw.plugin-D-kebf8t.js";
//#region extensions/mistral/provider-catalog.ts
function buildMistralProvider() {
	return buildManifestModelProviderConfig({
		providerId: "mistral",
		catalog: modelCatalog.providers.mistral
	});
}
//#endregion
export { buildMistralProvider as t };
