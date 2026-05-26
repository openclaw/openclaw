import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { t as isChutesModelDiscoveryTestEnvironment } from "./model-discovery-env-BenPR_Fw.js";
//#region extensions/chutes/models.ts
const log = createSubsystemLogger("chutes-models");
const CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
const CHUTES_DEFAULT_MODEL_ID = "zai-org/GLM-4.7-TEE";
const CHUTES_DEFAULT_MODEL_REF = `chutes/${CHUTES_DEFAULT_MODEL_ID}`;
const CHUTES_DEFAULT_CONTEXT_WINDOW = 128e3;
const CHUTES_DEFAULT_MAX_TOKENS = 4096;
const CHUTES_MODEL_CATALOG = [
	{
		id: "Qwen/Qwen3-32B",
		name: "Qwen/Qwen3-32B",
		reasoning: true,
		input: ["text"],
		contextWindow: 40960,
		maxTokens: 40960,
		cost: {
			input: .08,
			output: .24,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/Mistral-Nemo-Instruct-2407",
		name: "unsloth/Mistral-Nemo-Instruct-2407",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .02,
			output: .04,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3-0324-TEE",
		name: "deepseek-ai/DeepSeek-V3-0324-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 65536,
		cost: {
			input: .25,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-235B-A22B-Instruct-2507-TEE",
		name: "Qwen/Qwen3-235B-A22B-Instruct-2507-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 65536,
		cost: {
			input: .08,
			output: .55,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "openai/gpt-oss-120b-TEE",
		name: "openai/gpt-oss-120b-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 65536,
		cost: {
			input: .05,
			output: .45,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "chutesai/Mistral-Small-3.1-24B-Instruct-2503",
		name: "chutesai/Mistral-Small-3.1-24B-Instruct-2503",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .03,
			output: .11,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.2-TEE",
		name: "deepseek-ai/DeepSeek-V3.2-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 65536,
		cost: {
			input: .28,
			output: .42,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "zai-org/GLM-4.7-TEE",
		name: "zai-org/GLM-4.7-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 65535,
		cost: {
			input: .4,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "moonshotai/Kimi-K2.5-TEE",
		name: "moonshotai/Kimi-K2.5-TEE",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 65535,
		cost: {
			input: .45,
			output: 2.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/gemma-3-27b-it",
		name: "unsloth/gemma-3-27b-it",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128e3,
		maxTokens: 65536,
		cost: {
			input: .04,
			output: .15,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "XiaomiMiMo/MiMo-V2-Flash-TEE",
		name: "XiaomiMiMo/MiMo-V2-Flash-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 65536,
		cost: {
			input: .09,
			output: .29,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "chutesai/Mistral-Small-3.2-24B-Instruct-2506",
		name: "chutesai/Mistral-Small-3.2-24B-Instruct-2506",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .06,
			output: .18,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-R1-0528-TEE",
		name: "deepseek-ai/DeepSeek-R1-0528-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 65536,
		cost: {
			input: .45,
			output: 2.15,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "zai-org/GLM-5-TEE",
		name: "zai-org/GLM-5-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 65535,
		cost: {
			input: .95,
			output: 3.15,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.1-TEE",
		name: "deepseek-ai/DeepSeek-V3.1-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 65536,
		cost: {
			input: .2,
			output: .8,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.1-Terminus-TEE",
		name: "deepseek-ai/DeepSeek-V3.1-Terminus-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 65536,
		cost: {
			input: .23,
			output: .9,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/gemma-3-4b-it",
		name: "unsloth/gemma-3-4b-it",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 96e3,
		maxTokens: 96e3,
		cost: {
			input: .01,
			output: .03,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "MiniMaxAI/MiniMax-M2.5-TEE",
		name: "MiniMaxAI/MiniMax-M2.5-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 196608,
		maxTokens: 65536,
		cost: {
			input: .3,
			output: 1.1,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "tngtech/DeepSeek-TNG-R1T2-Chimera",
		name: "tngtech/DeepSeek-TNG-R1T2-Chimera",
		reasoning: true,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 163840,
		cost: {
			input: .25,
			output: .85,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-Coder-Next-TEE",
		name: "Qwen/Qwen3-Coder-Next-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 65536,
		cost: {
			input: .12,
			output: .75,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "NousResearch/Hermes-4-405B-FP8-TEE",
		name: "NousResearch/Hermes-4-405B-FP8-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 65536,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3",
		name: "deepseek-ai/DeepSeek-V3",
		reasoning: false,
		input: ["text"],
		contextWindow: 163840,
		maxTokens: 163840,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "openai/gpt-oss-20b",
		name: "openai/gpt-oss-20b",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .04,
			output: .15,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/Llama-3.2-3B-Instruct",
		name: "unsloth/Llama-3.2-3B-Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 4096,
		cost: {
			input: .01,
			output: .01,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/Mistral-Small-24B-Instruct-2501",
		name: "unsloth/Mistral-Small-24B-Instruct-2501",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 32768,
		maxTokens: 32768,
		cost: {
			input: .07,
			output: .3,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "zai-org/GLM-4.7-FP8",
		name: "zai-org/GLM-4.7-FP8",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 65535,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "zai-org/GLM-4.6-TEE",
		name: "zai-org/GLM-4.6-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 65536,
		cost: {
			input: .4,
			output: 1.7,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3.5-397B-A17B-TEE",
		name: "Qwen/Qwen3.5-397B-A17B-TEE",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 65536,
		cost: {
			input: .55,
			output: 3.5,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen2.5-72B-Instruct",
		name: "Qwen/Qwen2.5-72B-Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 32768,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "NousResearch/DeepHermes-3-Mistral-24B-Preview",
		name: "NousResearch/DeepHermes-3-Mistral-24B-Preview",
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 32768,
		cost: {
			input: .02,
			output: .1,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-Next-80B-A3B-Instruct",
		name: "Qwen/Qwen3-Next-80B-A3B-Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 262144,
		cost: {
			input: .1,
			output: .8,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "zai-org/GLM-4.6-FP8",
		name: "zai-org/GLM-4.6-FP8",
		reasoning: true,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 65535,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-235B-A22B-Thinking-2507",
		name: "Qwen/Qwen3-235B-A22B-Thinking-2507",
		reasoning: true,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 262144,
		cost: {
			input: .11,
			output: .6,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
		name: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .03,
			output: .11,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "tngtech/R1T2-Chimera-Speed",
		name: "tngtech/R1T2-Chimera-Speed",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 65536,
		cost: {
			input: .22,
			output: .6,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "zai-org/GLM-4.6V",
		name: "zai-org/GLM-4.6V",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 65536,
		cost: {
			input: .3,
			output: .9,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen2.5-VL-32B-Instruct",
		name: "Qwen/Qwen2.5-VL-32B-Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 16384,
		maxTokens: 16384,
		cost: {
			input: .05,
			output: .22,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-VL-235B-A22B-Instruct",
		name: "Qwen/Qwen3-VL-235B-A22B-Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 262144,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-14B",
		name: "Qwen/Qwen3-14B",
		reasoning: true,
		input: ["text"],
		contextWindow: 40960,
		maxTokens: 40960,
		cost: {
			input: .05,
			output: .22,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen2.5-Coder-32B-Instruct",
		name: "Qwen/Qwen2.5-Coder-32B-Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 32768,
		cost: {
			input: .03,
			output: .11,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3-30B-A3B",
		name: "Qwen/Qwen3-30B-A3B",
		reasoning: true,
		input: ["text"],
		contextWindow: 40960,
		maxTokens: 40960,
		cost: {
			input: .06,
			output: .22,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/gemma-3-12b-it",
		name: "unsloth/gemma-3-12b-it",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .03,
			output: .1,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "unsloth/Llama-3.2-1B-Instruct",
		name: "unsloth/Llama-3.2-1B-Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 4096,
		cost: {
			input: .01,
			output: .01,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16-TEE",
		name: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16-TEE",
		reasoning: true,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 4096,
		cost: {
			input: .3,
			output: 1.2,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "NousResearch/Hermes-4-14B",
		name: "NousResearch/Hermes-4-14B",
		reasoning: true,
		input: ["text"],
		contextWindow: 40960,
		maxTokens: 40960,
		cost: {
			input: .01,
			output: .05,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "Qwen/Qwen3Guard-Gen-0.6B",
		name: "Qwen/Qwen3Guard-Gen-0.6B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 4096,
		cost: {
			input: .01,
			output: .01,
			cacheRead: 0,
			cacheWrite: 0
		}
	},
	{
		id: "rednote-hilab/dots.ocr",
		name: "rednote-hilab/dots.ocr",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 131072,
		maxTokens: 131072,
		cost: {
			input: .01,
			output: .01,
			cacheRead: 0,
			cacheWrite: 0
		}
	}
];
function buildChutesModelDefinition(model) {
	return {
		...model,
		compat: { supportsUsageInStreaming: false }
	};
}
const CACHE_TTL = 300 * 1e3;
const CACHE_MAX_ENTRIES = 100;
const modelCache = /* @__PURE__ */ new Map();
function clearChutesModelCacheForTests() {
	modelCache.clear();
}
function pruneExpiredCacheEntries(now = Date.now()) {
	for (const [key, entry] of modelCache.entries()) if (now - entry.time >= CACHE_TTL) modelCache.delete(key);
}
function cacheAndReturn(tokenKey, models) {
	const now = Date.now();
	pruneExpiredCacheEntries(now);
	if (!modelCache.has(tokenKey) && modelCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = modelCache.keys().next();
		if (!oldest.done) modelCache.delete(oldest.value);
	}
	modelCache.set(tokenKey, {
		models,
		time: now
	});
	return models;
}
async function discoverChutesModels(accessToken) {
	const trimmedKey = normalizeOptionalString(accessToken) ?? "";
	pruneExpiredCacheEntries(Date.now());
	const cached = modelCache.get(trimmedKey);
	if (cached) return cached.models;
	if (isChutesModelDiscoveryTestEnvironment()) return CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition);
	let effectiveKey = trimmedKey;
	const staticCatalog = () => cacheAndReturn(effectiveKey, CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition));
	const headers = {};
	if (trimmedKey) headers.Authorization = `Bearer ${trimmedKey}`;
	try {
		let guardedFetch = await fetchWithSsrFGuard({
			url: `${CHUTES_BASE_URL}/models`,
			init: {
				signal: AbortSignal.timeout(1e4),
				headers
			},
			policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(CHUTES_BASE_URL),
			auditContext: "chutes-model-discovery"
		});
		let response = guardedFetch.response;
		if (response.status === 401 && trimmedKey) {
			await guardedFetch.release();
			effectiveKey = "";
			guardedFetch = await fetchWithSsrFGuard({
				url: `${CHUTES_BASE_URL}/models`,
				init: { signal: AbortSignal.timeout(1e4) },
				policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(CHUTES_BASE_URL),
				auditContext: "chutes-model-discovery"
			});
			response = guardedFetch.response;
		}
		try {
			if (!response.ok) {
				if (response.status !== 401 && response.status !== 503) log.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
				return staticCatalog();
			}
			const data = (await response.json())?.data;
			if (!Array.isArray(data) || data.length === 0) {
				log.warn("No models in response, using static catalog");
				return staticCatalog();
			}
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const entry of data) {
				const id = normalizeOptionalString(entry?.id) ?? "";
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const lowerId = normalizeLowercaseStringOrEmpty(id);
				const isReasoning = entry.supported_features?.includes("reasoning") || lowerId.includes("r1") || lowerId.includes("thinking") || lowerId.includes("reason") || lowerId.includes("tee");
				const input = (entry.input_modalities || ["text"]).filter((i) => i === "text" || i === "image");
				models.push({
					id,
					name: id,
					reasoning: isReasoning,
					input,
					cost: {
						input: entry.pricing?.prompt || 0,
						output: entry.pricing?.completion || 0,
						cacheRead: 0,
						cacheWrite: 0
					},
					contextWindow: entry.context_length || CHUTES_DEFAULT_CONTEXT_WINDOW,
					maxTokens: entry.max_output_length || CHUTES_DEFAULT_MAX_TOKENS,
					compat: { supportsUsageInStreaming: false }
				});
			}
			return cacheAndReturn(effectiveKey, models.length > 0 ? models : CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition));
		} finally {
			await guardedFetch.release();
		}
	} catch (error) {
		log.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return staticCatalog();
	}
}
//#endregion
export { buildChutesModelDefinition as a, CHUTES_MODEL_CATALOG as i, CHUTES_DEFAULT_MODEL_ID as n, clearChutesModelCacheForTests as o, CHUTES_DEFAULT_MODEL_REF as r, discoverChutesModels as s, CHUTES_BASE_URL as t };
