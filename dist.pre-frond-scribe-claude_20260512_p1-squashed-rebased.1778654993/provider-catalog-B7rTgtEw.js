import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-CzZiaLF-.js";
import { t as modelCatalog } from "./openclaw.plugin-CAP9L2-z.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
