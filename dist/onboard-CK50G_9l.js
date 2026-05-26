import { n as applyAgentDefaultModelPrimary, r as applyOnboardAuthAgentModelsAndProviders } from "./provider-onboard-MLXAQX8H.js";
import { i as MINIMAX_API_BASE_URL, m as buildMinimaxApiModelDefinition, s as MINIMAX_CN_API_BASE_URL } from "./model-definitions-D89tGcBi.js";
//#region extensions/minimax/onboard.ts
function applyMinimaxApiProviderConfigWithBaseUrl(cfg, params) {
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers[params.providerId];
	const existingModels = existingProvider?.models ?? [];
	const apiModel = buildMinimaxApiModelDefinition(params.modelId);
	const mergedModels = existingModels.some((model) => model.id === params.modelId) ? existingModels : [...existingModels, apiModel];
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
		baseUrl: params.baseUrl,
		models: []
	};
	const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : void 0;
	const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
	providers[params.providerId] = {
		...existingProviderRest,
		baseUrl: params.baseUrl,
		api: "anthropic-messages",
		authHeader: true,
		...normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : [apiModel]
	};
	const models = { ...cfg.agents?.defaults?.models };
	const modelRef = `${params.providerId}/${params.modelId}`;
	models[modelRef] = {
		...models[modelRef],
		alias: "Minimax"
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyMinimaxApiConfigWithBaseUrl(cfg, params) {
	return applyAgentDefaultModelPrimary(applyMinimaxApiProviderConfigWithBaseUrl(cfg, params), `${params.providerId}/${params.modelId}`);
}
function applyMinimaxApiProviderConfig(cfg, modelId = "MiniMax-M2.7") {
	return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_API_BASE_URL
	});
}
function applyMinimaxApiConfig(cfg, modelId = "MiniMax-M2.7") {
	return applyMinimaxApiConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_API_BASE_URL
	});
}
function applyMinimaxApiProviderConfigCn(cfg, modelId = "MiniMax-M2.7") {
	return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_CN_API_BASE_URL
	});
}
function applyMinimaxApiConfigCn(cfg, modelId = "MiniMax-M2.7") {
	return applyMinimaxApiConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_CN_API_BASE_URL
	});
}
//#endregion
export { applyMinimaxApiProviderConfigCn as i, applyMinimaxApiConfigCn as n, applyMinimaxApiProviderConfig as r, applyMinimaxApiConfig as t };
