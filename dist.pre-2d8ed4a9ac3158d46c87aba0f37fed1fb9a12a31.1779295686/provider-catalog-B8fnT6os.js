import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BaaxfOrS.js";
import { t as modelCatalog } from "./openclaw.plugin-dWt-F4uf.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
