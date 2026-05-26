import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { t as isHuggingfaceModelDiscoveryTestEnvironment } from "./model-discovery-env-80UUkp8S.js";
//#region extensions/huggingface/models.ts
const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
const HUGGINGFACE_POLICY_SUFFIXES = ["cheapest", "fastest"];
const HUGGINGFACE_DISCOVERY_TIMEOUT_MS = 3e4;
const HUGGINGFACE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const HUGGINGFACE_DEFAULT_CONTEXT_WINDOW = 131072;
const HUGGINGFACE_DEFAULT_MAX_TOKENS = 8192;
const HUGGINGFACE_MODEL_CATALOG = [
	{
		id: "deepseek-ai/DeepSeek-R1",
		name: "DeepSeek R1",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: 3,
			output: 7,
			cacheRead: 3,
			cacheWrite: 3
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.1",
		name: "DeepSeek V3.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .6,
			output: 1.25,
			cacheRead: .6,
			cacheWrite: .6
		}
	},
	{
		id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
		name: "Llama 3.3 70B Instruct Turbo",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .88,
			output: .88,
			cacheRead: .88,
			cacheWrite: .88
		}
	},
	{
		id: "openai/gpt-oss-120b",
		name: "GPT-OSS 120B",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		}
	}
];
function isHuggingfacePolicyLocked(modelRef) {
	const ref = modelRef.trim();
	return HUGGINGFACE_POLICY_SUFFIXES.some((suffix) => ref.endsWith(`:${suffix}`) || ref === suffix);
}
function buildHuggingfaceModelDefinition(model) {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens
	};
}
function isReasoningModelHeuristic(modelId) {
	const lower = normalizeLowercaseStringOrEmpty(modelId);
	return lower.includes("r1") || lower.includes("reason") || lower.includes("thinking") || lower.includes("reasoner") || lower.includes("grok") || lower.includes("qwq");
}
function inferredMetaFromModelId(id) {
	const base = id.split("/").pop() ?? id;
	const reasoning = isReasoningModelHeuristic(id);
	return {
		name: base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase()),
		reasoning
	};
}
function displayNameFromApiEntry(entry, inferredName) {
	const fromApi = typeof entry.name === "string" && entry.name.trim() || typeof entry.title === "string" && entry.title.trim() || typeof entry.display_name === "string" && entry.display_name.trim();
	if (fromApi) return fromApi;
	if (typeof entry.owned_by === "string" && entry.owned_by.trim()) {
		const base = entry.id.split("/").pop() ?? entry.id;
		return `${entry.owned_by.trim()}/${base}`;
	}
	return inferredName;
}
async function discoverHuggingfaceModels(apiKey, timeoutMs = HUGGINGFACE_DISCOVERY_TIMEOUT_MS) {
	if (isHuggingfaceModelDiscoveryTestEnvironment()) return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	const trimmedKey = apiKey?.trim();
	if (!trimmedKey) return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url: `${HUGGINGFACE_BASE_URL}/models`,
			init: {
				signal: AbortSignal.timeout(timeoutMs),
				headers: {
					Authorization: `Bearer ${trimmedKey}`,
					"Content-Type": "application/json"
				}
			},
			policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(HUGGINGFACE_BASE_URL),
			auditContext: "huggingface-model-discovery"
		});
		try {
			if (!response.ok) return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
			const data = (await response.json())?.data;
			if (!Array.isArray(data) || data.length === 0) return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
			const catalogById = new Map(HUGGINGFACE_MODEL_CATALOG.map((model) => [model.id, model]));
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const entry of data) {
				const id = typeof entry?.id === "string" ? entry.id.trim() : "";
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const catalogEntry = catalogById.get(id);
				if (catalogEntry) {
					models.push(buildHuggingfaceModelDefinition(catalogEntry));
					continue;
				}
				const inferred = inferredMetaFromModelId(id);
				const name = displayNameFromApiEntry(entry, inferred.name);
				const modalities = entry.architecture?.input_modalities;
				const input = Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
				const providerWithContext = (Array.isArray(entry.providers) ? entry.providers : []).find((provider) => typeof provider?.context_length === "number" && provider.context_length > 0);
				models.push({
					id,
					name,
					reasoning: inferred.reasoning,
					input,
					cost: HUGGINGFACE_DEFAULT_COST,
					contextWindow: providerWithContext?.context_length ?? HUGGINGFACE_DEFAULT_CONTEXT_WINDOW,
					maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS
				});
			}
			return models.length > 0 ? models : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
		} finally {
			await release();
		}
	} catch {
		return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	}
}
//#endregion
export { buildHuggingfaceModelDefinition as a, HUGGINGFACE_POLICY_SUFFIXES as i, HUGGINGFACE_DISCOVERY_TIMEOUT_MS as n, discoverHuggingfaceModels as o, HUGGINGFACE_MODEL_CATALOG as r, isHuggingfacePolicyLocked as s, HUGGINGFACE_BASE_URL as t };
