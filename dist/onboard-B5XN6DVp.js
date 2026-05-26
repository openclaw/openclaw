import { a as applyProviderConfigWithDefaultModel, n as applyAgentDefaultModelPrimary } from "./provider-onboard-MLXAQX8H.js";
import { a as resolveCloudflareAiGatewayBaseUrl, i as buildCloudflareAiGatewayModelDefinition, n as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF } from "./models-CuqyJ_Cc.js";
//#region extensions/cloudflare-ai-gateway/onboard.ts
function buildCloudflareAiGatewayConfigPatch(params) {
	return {
		models: { providers: { "cloudflare-ai-gateway": {
			baseUrl: resolveCloudflareAiGatewayBaseUrl(params),
			api: "anthropic-messages",
			models: [buildCloudflareAiGatewayModelDefinition()]
		} } },
		agents: { defaults: { models: { [CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]: { alias: "Cloudflare AI Gateway" } } } }
	};
}
function applyCloudflareAiGatewayProviderConfig(cfg, params) {
	const models = { ...cfg.agents?.defaults?.models };
	models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
		...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
		alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway"
	};
	const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"];
	const baseUrl = params?.accountId && params?.gatewayId ? resolveCloudflareAiGatewayBaseUrl({
		accountId: params.accountId,
		gatewayId: params.gatewayId
	}) : typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : void 0;
	if (!baseUrl) return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "cloudflare-ai-gateway",
		api: "anthropic-messages",
		baseUrl,
		defaultModel: buildCloudflareAiGatewayModelDefinition()
	});
}
function applyCloudflareAiGatewayConfig(cfg, params) {
	return applyAgentDefaultModelPrimary(applyCloudflareAiGatewayProviderConfig(cfg, params), CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF);
}
//#endregion
export { applyCloudflareAiGatewayProviderConfig as n, buildCloudflareAiGatewayConfigPatch as r, applyCloudflareAiGatewayConfig as t };
