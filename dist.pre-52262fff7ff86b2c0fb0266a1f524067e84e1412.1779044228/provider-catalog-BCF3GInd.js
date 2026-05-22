import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Hc1kZdh8.js";
import { t as modelCatalog } from "./openclaw.plugin-Cpwe6LnG.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
