import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-a4yGG8eg.js";
import { t as modelCatalog } from "./openclaw.plugin-Dy9Hr80F.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
