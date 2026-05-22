import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-Bqa0paW_.js";
import { t as modelCatalog } from "./openclaw.plugin-vdSQa_2e.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
