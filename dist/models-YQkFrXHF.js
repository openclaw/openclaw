import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { f as readProviderJsonArrayFieldResponse } from "./provider-http-errors-C90BH-le.js";
import "./runtime-env-BtvWnLRh.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/vercel-ai-gateway/models.ts
const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = `${VERCEL_AI_GATEWAY_PROVIDER_ID}/${VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID}`;
const VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 2e5;
const VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS = 128e3;
const VERCEL_AI_GATEWAY_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const log = createSubsystemLogger("agents/vercel-ai-gateway");
const STATIC_VERCEL_AI_GATEWAY_MODEL_CATALOG = [
	{
		id: "anthropic/claude-opus-4.6",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 128e3,
		cost: {
			input: 5,
			output: 25,
			cacheRead: .5,
			cacheWrite: 6.25
		}
	},
	{
		id: "openai/gpt-5.4",
		name: "GPT 5.4",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 2e5,
		maxTokens: 128e3,
		cost: {
			input: 2.5,
			output: 15,
			cacheRead: .25
		}
	},
	{
		id: "openai/gpt-5.4-pro",
		name: "GPT 5.4 Pro",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 2e5,
		maxTokens: 128e3,
		cost: {
			input: 30,
			output: 180,
			cacheRead: 0
		}
	},
	{
		id: "moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 262144,
		cost: {
			input: .95,
			output: 4,
			cacheRead: .16
		}
	}
];
function toPerMillionCost(value) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
	if (!Number.isFinite(numeric) || numeric < 0) return 0;
	return numeric * 1e6;
}
function normalizeCost(pricing) {
	return {
		input: toPerMillionCost(pricing?.input),
		output: toPerMillionCost(pricing?.output),
		cacheRead: toPerMillionCost(pricing?.input_cache_read),
		cacheWrite: toPerMillionCost(pricing?.input_cache_write)
	};
}
function buildStaticModelDefinition(model) {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: {
			...VERCEL_AI_GATEWAY_DEFAULT_COST,
			...model.cost
		}
	};
}
function getStaticFallbackModel(id) {
	const fallback = STATIC_VERCEL_AI_GATEWAY_MODEL_CATALOG.find((model) => model.id === id);
	return fallback ? buildStaticModelDefinition(fallback) : void 0;
}
function getStaticVercelAiGatewayModelCatalog() {
	return STATIC_VERCEL_AI_GATEWAY_MODEL_CATALOG.map(buildStaticModelDefinition);
}
function buildDiscoveredModelDefinition(model) {
	const id = typeof model.id === "string" ? model.id.trim() : "";
	if (!id) return null;
	const fallback = getStaticFallbackModel(id);
	const contextWindow = typeof model.context_window === "number" && Number.isFinite(model.context_window) ? model.context_window : fallback?.contextWindow ?? 2e5;
	const maxTokens = typeof model.max_tokens === "number" && Number.isFinite(model.max_tokens) ? model.max_tokens : fallback?.maxTokens ?? 128e3;
	const normalizedCost = normalizeCost(model.pricing);
	return {
		id,
		name: (typeof model.name === "string" ? model.name.trim() : "") || fallback?.name || id,
		reasoning: Array.isArray(model.tags) && model.tags.includes("reasoning") ? true : fallback?.reasoning ?? false,
		input: Array.isArray(model.tags) ? model.tags.includes("vision") ? ["text", "image"] : ["text"] : fallback?.input ?? ["text"],
		contextWindow,
		maxTokens,
		cost: normalizedCost.input > 0 || normalizedCost.output > 0 || normalizedCost.cacheRead > 0 || normalizedCost.cacheWrite > 0 ? normalizedCost : fallback?.cost ?? VERCEL_AI_GATEWAY_DEFAULT_COST
	};
}
function asVercelGatewayModelShape(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Vercel AI Gateway model list: malformed JSON response");
	return value;
}
async function discoverVercelAiGatewayModels() {
	if (process.env.VITEST || false) return getStaticVercelAiGatewayModelCatalog();
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url: `${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`,
			timeoutMs: 5e3,
			auditContext: "vercel-ai-gateway.models"
		});
		try {
			if (!response.ok) {
				log.warn(`Failed to discover Vercel AI Gateway models: HTTP ${response.status}`);
				return getStaticVercelAiGatewayModelCatalog();
			}
			const discovered = (await readProviderJsonArrayFieldResponse(response, "Vercel AI Gateway model list", "data")).map(asVercelGatewayModelShape).map(buildDiscoveredModelDefinition).filter((entry) => entry !== null);
			return discovered.length > 0 ? discovered : getStaticVercelAiGatewayModelCatalog();
		} finally {
			await release();
		}
	} catch (error) {
		log.warn(`Failed to discover Vercel AI Gateway models: ${String(error)}`);
		return getStaticVercelAiGatewayModelCatalog();
	}
}
//#endregion
export { VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID as a, discoverVercelAiGatewayModels as c, VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS as i, getStaticVercelAiGatewayModelCatalog as l, VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW as n, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF as o, VERCEL_AI_GATEWAY_DEFAULT_COST as r, VERCEL_AI_GATEWAY_PROVIDER_ID as s, VERCEL_AI_GATEWAY_BASE_URL as t };
