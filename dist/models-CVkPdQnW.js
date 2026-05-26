import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-4kkagm5f.js";
import { t as modelCatalog } from "./openclaw.plugin-mt5kV5Z5.js";
//#region extensions/together/models.ts
const TOGETHER_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "together",
	catalog: modelCatalog.providers.together
});
const TOGETHER_BASE_URL = TOGETHER_MANIFEST_PROVIDER.baseUrl;
const TOGETHER_MODEL_CATALOG = TOGETHER_MANIFEST_PROVIDER.models;
function buildTogetherModelDefinition(model) {
	return {
		...model,
		api: "openai-completions",
		input: [...model.input],
		cost: { ...model.cost }
	};
}
//#endregion
export { TOGETHER_MODEL_CATALOG as n, buildTogetherModelDefinition as r, TOGETHER_BASE_URL as t };
