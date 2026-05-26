import { c as discoverVercelAiGatewayModels, l as getStaticVercelAiGatewayModelCatalog, t as VERCEL_AI_GATEWAY_BASE_URL } from "./models-YQkFrXHF.js";
//#region extensions/vercel-ai-gateway/provider-catalog.ts
function buildStaticVercelAiGatewayProvider() {
	return {
		baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
		api: "anthropic-messages",
		models: getStaticVercelAiGatewayModelCatalog()
	};
}
async function buildVercelAiGatewayProvider() {
	return {
		baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
		api: "anthropic-messages",
		models: await discoverVercelAiGatewayModels()
	};
}
//#endregion
export { buildVercelAiGatewayProvider as n, buildStaticVercelAiGatewayProvider as t };
