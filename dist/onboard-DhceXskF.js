import { l as applyProviderConfigWithModelCatalog, n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
import { i as buildTokenHubModelDefinition, n as TOKENHUB_MODEL_CATALOG, r as TOKENHUB_PROVIDER_ID, t as TOKENHUB_BASE_URL } from "./models-NbkgAGHo.js";
import "./api-BuWmQ8-_.js";
//#region extensions/tencent/onboard.ts
const TOKENHUB_DEFAULT_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3-preview`;
function applyTokenHubProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[TOKENHUB_DEFAULT_MODEL_REF] = {
		...models[TOKENHUB_DEFAULT_MODEL_REF],
		alias: models[TOKENHUB_DEFAULT_MODEL_REF]?.alias ?? "Hy3 preview (TokenHub)"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: TOKENHUB_PROVIDER_ID,
		api: "openai-completions",
		baseUrl: TOKENHUB_BASE_URL,
		catalogModels: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition)
	});
}
function applyTokenHubConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyTokenHubProviderConfig(cfg), TOKENHUB_DEFAULT_MODEL_REF);
}
//#endregion
export { applyTokenHubConfig as n, TOKENHUB_DEFAULT_MODEL_REF as t };
