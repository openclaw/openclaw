import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-4kkagm5f.js";
import { t as modelCatalog } from "./openclaw.plugin-mt5kV5Z5.js";
//#region extensions/together/provider-catalog.ts
function buildTogetherProvider() {
	return buildManifestModelProviderConfig({
		providerId: "together",
		catalog: modelCatalog.providers.together
	});
}
//#endregion
export { buildTogetherProvider as t };
