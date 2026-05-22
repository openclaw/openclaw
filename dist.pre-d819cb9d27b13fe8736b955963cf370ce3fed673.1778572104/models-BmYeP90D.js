//#region extensions/cloudflare-ai-gateway/models.ts
const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `${CLOUDFLARE_AI_GATEWAY_PROVIDER_ID}/${CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID}`;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 2e5;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS = 64e3;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_COST = {
	input: 3,
	output: 15,
	cacheRead: .3,
	cacheWrite: 3.75
};
function buildCloudflareAiGatewayModelDefinition(params) {
	return {
		id: params?.id?.trim() || "claude-sonnet-4-6",
		name: params?.name ?? "Claude Sonnet 4.6",
		reasoning: params?.reasoning ?? true,
		input: params?.input ?? ["text", "image"],
		cost: CLOUDFLARE_AI_GATEWAY_DEFAULT_COST,
		contextWindow: CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
		maxTokens: CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS
	};
}
function resolveCloudflareAiGatewayBaseUrl(params) {
	const accountId = params.accountId.trim();
	const gatewayId = params.gatewayId.trim();
	if (!accountId || !gatewayId) return "";
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}
//#endregion
export { resolveCloudflareAiGatewayBaseUrl as a, buildCloudflareAiGatewayModelDefinition as i, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF as n, CLOUDFLARE_AI_GATEWAY_PROVIDER_ID as r, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID as t };
