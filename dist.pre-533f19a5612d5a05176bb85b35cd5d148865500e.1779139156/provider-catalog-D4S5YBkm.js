import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CO8moCmL.js";
import { t as modelCatalog } from "./openclaw.plugin-CQtOrnXf.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
