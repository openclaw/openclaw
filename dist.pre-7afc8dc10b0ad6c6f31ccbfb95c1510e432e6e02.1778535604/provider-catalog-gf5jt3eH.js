import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-C1Bm1vy2.js";
import { t as modelCatalog } from "./openclaw.plugin-BRgBsjDC.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
