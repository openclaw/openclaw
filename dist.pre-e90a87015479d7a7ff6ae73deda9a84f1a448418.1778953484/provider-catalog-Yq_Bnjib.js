import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CZwfu6ul.js";
import { t as modelCatalog } from "./openclaw.plugin-D2TpOfN6.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
