import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-NZuRh3rG.js";
import { t as modelCatalog } from "./openclaw.plugin-Bah8bJBa.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
