import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-fMC-0vbQ.js";
import { t as modelCatalog } from "./openclaw.plugin-BgFnOPI6.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
