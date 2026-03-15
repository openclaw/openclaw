import { t as createSubsystemLogger } from "./subsystem-CsP80x3t.js";
import { n as retryAsync } from "./retry-BY_ggjbn.js";
import { o as KILOCODE_MODEL_CATALOG, r as KILOCODE_DEFAULT_COST, t as KILOCODE_BASE_URL } from "./kilocode-shared-Ci8SRxXc.js";
import { i as SGLANG_PROVIDER_LABEL } from "./sglang-defaults-CzghSv6A.js";
import { i as VLLM_PROVIDER_LABEL } from "./vllm-defaults-DLfSffbg.js";
//#region src/agents/ollama-defaults.ts
const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
const OLLAMA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OLLAMA_SHOW_CONCURRENCY$1 = 8;
/**
* Derive the Ollama native API base URL from a configured base URL.
*
* Users typically configure `baseUrl` with a `/v1` suffix (e.g.
* `http://192.168.20.14:11434/v1`) for the OpenAI-compatible endpoint.
* The native Ollama API lives at the root (e.g. `/api/tags`), so we
* strip the `/v1` suffix when present.
*/
function resolveOllamaApiBase(configuredBaseUrl) {
	if (!configuredBaseUrl) {return OLLAMA_DEFAULT_BASE_URL;}
	return configuredBaseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}
async function queryOllamaContextWindow(apiBase, modelName) {
	try {
		const response = await fetch(`${apiBase}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: modelName }),
			signal: AbortSignal.timeout(3e3)
		});
		if (!response.ok) {return;}
		const data = await response.json();
		if (!data.model_info) {return;}
		for (const [key, value] of Object.entries(data.model_info)) {if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
			const contextWindow = Math.floor(value);
			if (contextWindow > 0) return contextWindow;
		}}
		return;
	} catch {
		return;
	}
}
async function enrichOllamaModelsWithContext(apiBase, models, opts) {
	const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY$1));
	const enriched = [];
	for (let index = 0; index < models.length; index += concurrency) {
		const batch = models.slice(index, index + concurrency);
		const batchResults = await Promise.all(batch.map(async (model) => ({
			...model,
			contextWindow: await queryOllamaContextWindow(apiBase, model.name)
		})));
		enriched.push(...batchResults);
	}
	return enriched;
}
/** Heuristic: treat models with "r1", "reasoning", or "think" in the name as reasoning models. */
function isReasoningModelHeuristic(modelId) {
	return /r1|reasoning|think|reason/i.test(modelId);
}
/** Build a ModelDefinitionConfig for an Ollama model with default values. */
function buildOllamaModelDefinition(modelId, contextWindow) {
	return {
		id: modelId,
		name: modelId,
		reasoning: isReasoningModelHeuristic(modelId),
		input: ["text"],
		cost: OLLAMA_DEFAULT_COST,
		contextWindow: contextWindow ?? 128e3,
		maxTokens: OLLAMA_DEFAULT_MAX_TOKENS
	};
}
/** Fetch the model list from a running Ollama instance. */
async function fetchOllamaModels(baseUrl) {
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const response = await fetch(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) {return {
			reachable: true,
			models: []
		};}
		return {
			reachable: true,
			models: ((await response.json()).models ?? []).filter((m) => m.name)
		};
	} catch {
		return {
			reachable: false,
			models: []
		};
	}
}
//#endregion
//#region src/agents/huggingface-models.ts
const log$4 = createSubsystemLogger("huggingface-models");
/** Hugging Face Inference Providers (router) — OpenAI-compatible chat completions. */
const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
/** Default cost when not in static catalog (HF pricing varies by provider). */
const HUGGINGFACE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Defaults for models discovered from GET /v1/models. */
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
/**
* Infer reasoning and display name from Hub-style model id (e.g. "deepseek-ai/DeepSeek-R1").
*/
function inferredMetaFromModelId(id) {
	const base = id.split("/").pop() ?? id;
	const reasoning = isReasoningModelHeuristic(id);
	return {
		name: base.replace(/-/g, " ").replace(/\b(\w)/g, (c) => c.toUpperCase()),
		reasoning
	};
}
/** Prefer API-supplied display name, then owned_by/id, then inferred from id. */
function displayNameFromApiEntry(entry, inferredName) {
	const fromApi = typeof entry.name === "string" && entry.name.trim() || typeof entry.title === "string" && entry.title.trim() || typeof entry.display_name === "string" && entry.display_name.trim();
	if (fromApi) {return fromApi;}
	if (typeof entry.owned_by === "string" && entry.owned_by.trim()) {
		const base = entry.id.split("/").pop() ?? entry.id;
		return `${entry.owned_by.trim()}/${base}`;
	}
	return inferredName;
}
/**
* Discover chat-completion models from Hugging Face Inference Providers (GET /v1/models).
* Requires a valid HF token. Falls back to static catalog on failure or in test env.
*/
async function discoverHuggingfaceModels(apiKey) {
	if (process.env.VITEST === "true" || false) {return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);}
	const trimmedKey = apiKey?.trim();
	if (!trimmedKey) {return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);}
	try {
		const response = await fetch(`${HUGGINGFACE_BASE_URL}/models`, {
			signal: AbortSignal.timeout(1e4),
			headers: {
				Authorization: `Bearer ${trimmedKey}`,
				"Content-Type": "application/json"
			}
		});
		if (!response.ok) {
			log$4.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
			return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
		}
		const data = (await response.json())?.data;
		if (!Array.isArray(data) || data.length === 0) {
			log$4.warn("No models in response, using static catalog");
			return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
		}
		const catalogById = new Map(HUGGINGFACE_MODEL_CATALOG.map((m) => [m.id, m]));
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const entry of data) {
			const id = typeof entry?.id === "string" ? entry.id.trim() : "";
			if (!id || seen.has(id)) {continue;}
			seen.add(id);
			const catalogEntry = catalogById.get(id);
			if (catalogEntry) {models.push(buildHuggingfaceModelDefinition(catalogEntry));}
			else {
				const inferred = inferredMetaFromModelId(id);
				const name = displayNameFromApiEntry(entry, inferred.name);
				const modalities = entry.architecture?.input_modalities;
				const input = Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"];
				const contextLength = (Array.isArray(entry.providers) ? entry.providers : []).find((p) => typeof p?.context_length === "number" && p.context_length > 0)?.context_length ?? HUGGINGFACE_DEFAULT_CONTEXT_WINDOW;
				models.push({
					id,
					name,
					reasoning: inferred.reasoning,
					input,
					cost: HUGGINGFACE_DEFAULT_COST,
					contextWindow: contextLength,
					maxTokens: HUGGINGFACE_DEFAULT_MAX_TOKENS
				});
			}
		}
		return models.length > 0 ? models : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	} catch (error) {
		log$4.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition);
	}
}
//#endregion
//#region src/agents/kilocode-models.ts
const log$3 = createSubsystemLogger("kilocode-models");
const KILOCODE_MODELS_URL = `${KILOCODE_BASE_URL}models`;
const DISCOVERY_TIMEOUT_MS = 5e3;
/**
* Convert per-token price (as returned by the gateway) to per-1M-token price
* (as stored in OpenClaw's ModelDefinitionConfig.cost).
*
* Gateway/OpenRouter prices are per-token strings like "0.000005".
* OpenClaw costs are per-1M-token numbers like 5.0.
*/
function toPricePerMillion(perToken) {
	if (!perToken) {return 0;}
	const num = Number(perToken);
	if (!Number.isFinite(num) || num < 0) {return 0;}
	return num * 1e6;
}
function parseModality(entry) {
	const modalities = entry.architecture?.input_modalities;
	if (!Array.isArray(modalities)) {return ["text"];}
	return modalities.some((m) => typeof m === "string" && m.toLowerCase() === "image") ? ["text", "image"] : ["text"];
}
function parseReasoning(entry) {
	const params = entry.supported_parameters;
	if (!Array.isArray(params)) {return false;}
	return params.includes("reasoning") || params.includes("include_reasoning");
}
function toModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name || entry.id,
		reasoning: parseReasoning(entry),
		input: parseModality(entry),
		cost: {
			input: toPricePerMillion(entry.pricing.prompt),
			output: toPricePerMillion(entry.pricing.completion),
			cacheRead: toPricePerMillion(entry.pricing.input_cache_read),
			cacheWrite: toPricePerMillion(entry.pricing.input_cache_write)
		},
		contextWindow: entry.context_length || 1e6,
		maxTokens: entry.top_provider?.max_completion_tokens ?? 128e3
	};
}
function buildStaticCatalog() {
	return KILOCODE_MODEL_CATALOG.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: KILOCODE_DEFAULT_COST,
		contextWindow: model.contextWindow ?? 1e6,
		maxTokens: model.maxTokens ?? 128e3
	}));
}
/**
* Discover models from the Kilo Gateway API with fallback to static catalog.
* The /api/gateway/models endpoint is public and doesn't require authentication.
*/
async function discoverKilocodeModels() {
	if (process.env.VITEST) {return buildStaticCatalog();}
	try {
		const response = await fetch(KILOCODE_MODELS_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
		if (!response.ok) {
			log$3.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
			return buildStaticCatalog();
		}
		const data = await response.json();
		if (!Array.isArray(data.data) || data.data.length === 0) {
			log$3.warn("No models found from gateway API, using static catalog");
			return buildStaticCatalog();
		}
		const models = [];
		const discoveredIds = /* @__PURE__ */ new Set();
		for (const entry of data.data) {
			if (!entry || typeof entry !== "object") {continue;}
			const id = typeof entry.id === "string" ? entry.id.trim() : "";
			if (!id || discoveredIds.has(id)) {continue;}
			try {
				models.push(toModelDefinition(entry));
				discoveredIds.add(id);
			} catch (e) {
				log$3.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
			}
		}
		const staticModels = buildStaticCatalog();
		for (const staticModel of staticModels) {if (!discoveredIds.has(staticModel.id)) models.unshift(staticModel);}
		return models.length > 0 ? models : buildStaticCatalog();
	} catch (error) {
		log$3.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return buildStaticCatalog();
	}
}
//#endregion
//#region src/agents/self-hosted-provider-defaults.ts
const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128e3;
const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
const SELF_HOSTED_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
//#endregion
//#region src/agents/venice-models.ts
const log$2 = createSubsystemLogger("venice-models");
const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const VENICE_DEFAULT_MODEL_REF = `venice/kimi-k2-5`;
const VENICE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const VENICE_DEFAULT_CONTEXT_WINDOW = 128e3;
const VENICE_DEFAULT_MAX_TOKENS = 4096;
const VENICE_DISCOVERY_HARD_MAX_TOKENS = 131072;
const VENICE_DISCOVERY_TIMEOUT_MS = 1e4;
const VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS = new Set([
	408,
	425,
	429,
	500,
	502,
	503,
	504
]);
const VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EAI_AGAIN",
	"ENETDOWN",
	"ENETUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_CONNECT_ERROR",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET"
]);
/**
* Complete catalog of Venice AI models.
*
* Venice provides two privacy modes:
* - "private": Fully private inference, no logging, ephemeral
* - "anonymized": Proxied through Venice with metadata stripped (for proprietary models)
*
* Note: The `privacy` field is included for documentation purposes but is not
* propagated to ModelDefinitionConfig as it's not part of the core model schema.
* Privacy mode is determined by the model itself, not configurable at runtime.
*
* This catalog serves as a fallback when the Venice API is unreachable.
*/
const VENICE_MODEL_CATALOG = [
	{
		id: "llama-3.3-70b",
		name: "Llama 3.3 70B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 4096,
		privacy: "private"
	},
	{
		id: "llama-3.2-3b",
		name: "Llama 3.2 3B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 4096,
		privacy: "private"
	},
	{
		id: "hermes-3-llama-3.1-405b",
		name: "Hermes 3 Llama 3.1 405B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 16384,
		supportsTools: false,
		privacy: "private"
	},
	{
		id: "qwen3-235b-a22b-thinking-2507",
		name: "Qwen3 235B Thinking",
		reasoning: true,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "qwen3-235b-a22b-instruct-2507",
		name: "Qwen3 235B Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "qwen3-coder-480b-a35b-instruct",
		name: "Qwen3 Coder 480B",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "private"
	},
	{
		id: "qwen3-coder-480b-a35b-instruct-turbo",
		name: "Qwen3 Coder 480B Turbo",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "private"
	},
	{
		id: "qwen3-5-35b-a3b",
		name: "Qwen3.5 35B A3B",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "private"
	},
	{
		id: "qwen3-next-80b",
		name: "Qwen3 Next 80B",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "qwen3-vl-235b-a22b",
		name: "Qwen3 VL 235B (Vision)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "qwen3-4b",
		name: "Venice Small (Qwen3 4B)",
		reasoning: true,
		input: ["text"],
		contextWindow: 32e3,
		maxTokens: 4096,
		privacy: "private"
	},
	{
		id: "deepseek-v3.2",
		name: "DeepSeek V3.2",
		reasoning: true,
		input: ["text"],
		contextWindow: 16e4,
		maxTokens: 32768,
		supportsTools: false,
		privacy: "private"
	},
	{
		id: "venice-uncensored",
		name: "Venice Uncensored (Dolphin-Mistral)",
		reasoning: false,
		input: ["text"],
		contextWindow: 32e3,
		maxTokens: 4096,
		supportsTools: false,
		privacy: "private"
	},
	{
		id: "mistral-31-24b",
		name: "Venice Medium (Mistral)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128e3,
		maxTokens: 4096,
		privacy: "private"
	},
	{
		id: "google-gemma-3-27b-it",
		name: "Google Gemma 3 27B Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 198e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "openai-gpt-oss-120b",
		name: "OpenAI GPT OSS 120B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "nvidia-nemotron-3-nano-30b-a3b",
		name: "NVIDIA Nemotron 3 Nano 30B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "olafangensan-glm-4.7-flash-heretic",
		name: "GLM 4.7 Flash Heretic",
		reasoning: true,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 24e3,
		privacy: "private"
	},
	{
		id: "zai-org-glm-4.6",
		name: "GLM 4.6",
		reasoning: false,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "zai-org-glm-4.7",
		name: "GLM 4.7",
		reasoning: true,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "zai-org-glm-4.7-flash",
		name: "GLM 4.7 Flash",
		reasoning: true,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "private"
	},
	{
		id: "zai-org-glm-5",
		name: "GLM 5",
		reasoning: true,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 32e3,
		privacy: "private"
	},
	{
		id: "kimi-k2-5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "private"
	},
	{
		id: "kimi-k2-thinking",
		name: "Kimi K2 Thinking",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "private"
	},
	{
		id: "minimax-m21",
		name: "MiniMax M2.1",
		reasoning: true,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 32768,
		privacy: "private"
	},
	{
		id: "minimax-m25",
		name: "MiniMax M2.5",
		reasoning: true,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 32768,
		privacy: "private"
	},
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 198e3,
		maxTokens: 32768,
		privacy: "anonymized"
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 128e3,
		privacy: "anonymized"
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 198e3,
		maxTokens: 64e3,
		privacy: "anonymized"
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 64e3,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-52",
		name: "GPT-5.2 (via Venice)",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-52-codex",
		name: "GPT-5.2 Codex (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-53-codex",
		name: "GPT-5.3 Codex (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 4e5,
		maxTokens: 128e3,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-54",
		name: "GPT-5.4 (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 131072,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-4o-2024-11-20",
		name: "GPT-4o (via Venice)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "anonymized"
	},
	{
		id: "openai-gpt-4o-mini-2024-07-18",
		name: "GPT-4o Mini (via Venice)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128e3,
		maxTokens: 16384,
		privacy: "anonymized"
	},
	{
		id: "gemini-3-pro-preview",
		name: "Gemini 3 Pro (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 198e3,
		maxTokens: 32768,
		privacy: "anonymized"
	},
	{
		id: "gemini-3-1-pro-preview",
		name: "Gemini 3.1 Pro (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 32768,
		privacy: "anonymized"
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 65536,
		privacy: "anonymized"
	},
	{
		id: "grok-41-fast",
		name: "Grok 4.1 Fast (via Venice)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1e6,
		maxTokens: 3e4,
		privacy: "anonymized"
	},
	{
		id: "grok-code-fast-1",
		name: "Grok Code Fast 1 (via Venice)",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 1e4,
		privacy: "anonymized"
	}
];
/**
* Build a ModelDefinitionConfig from a Venice catalog entry.
*
* Note: The `privacy` field from the catalog is not included in the output
* as ModelDefinitionConfig doesn't support custom metadata fields. Privacy
* mode is inherent to each model and documented in the catalog/docs.
*/
function buildVeniceModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: VENICE_DEFAULT_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: {
			supportsUsageInStreaming: false,
			..."supportsTools" in entry && !entry.supportsTools ? { supportsTools: false } : {}
		}
	};
}
var VeniceDiscoveryHttpError = class extends Error {
	constructor(status) {
		super(`HTTP ${status}`);
		this.name = "VeniceDiscoveryHttpError";
		this.status = status;
	}
};
function staticVeniceModelDefinitions() {
	return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
}
function hasRetryableNetworkCode(err) {
	const queue = [err];
	const seen = /* @__PURE__ */ new Set();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || typeof current !== "object" || seen.has(current)) {continue;}
		seen.add(current);
		const candidate = current;
		const code = typeof candidate.code === "string" ? candidate.code : typeof candidate.errno === "string" ? candidate.errno : void 0;
		if (code && VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES.has(code)) {return true;}
		if (candidate.cause) {queue.push(candidate.cause);}
		if (Array.isArray(candidate.errors)) {queue.push(...candidate.errors);}
	}
	return false;
}
function isRetryableVeniceDiscoveryError(err) {
	if (err instanceof VeniceDiscoveryHttpError) {return true;}
	if (err instanceof Error && err.name === "AbortError") {return true;}
	if (err instanceof TypeError && err.message.toLowerCase() === "fetch failed") {return true;}
	return hasRetryableNetworkCode(err);
}
function normalizePositiveInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {return;}
	return Math.floor(value);
}
function resolveApiMaxCompletionTokens(params) {
	const raw = normalizePositiveInt(params.apiModel.model_spec?.maxCompletionTokens);
	if (!raw) {return;}
	const contextWindow = normalizePositiveInt(params.apiModel.model_spec?.availableContextTokens);
	const knownMaxTokens = typeof params.knownMaxTokens === "number" && Number.isFinite(params.knownMaxTokens) ? Math.floor(params.knownMaxTokens) : void 0;
	const hardCap = knownMaxTokens ?? VENICE_DISCOVERY_HARD_MAX_TOKENS;
	const fallbackContextWindow = knownMaxTokens ?? VENICE_DEFAULT_CONTEXT_WINDOW;
	return Math.min(raw, contextWindow ?? fallbackContextWindow, hardCap);
}
function resolveApiSupportsTools(apiModel) {
	const supportsFunctionCalling = apiModel.model_spec?.capabilities?.supportsFunctionCalling;
	return typeof supportsFunctionCalling === "boolean" ? supportsFunctionCalling : void 0;
}
/**
* Discover models from Venice API with fallback to static catalog.
* The /models endpoint is public and doesn't require authentication.
*/
async function discoverVeniceModels() {
	if (process.env.VITEST) {return staticVeniceModelDefinitions();}
	try {
		const response = await retryAsync(async () => {
			const currentResponse = await fetch(`${VENICE_BASE_URL}/models`, {
				signal: AbortSignal.timeout(VENICE_DISCOVERY_TIMEOUT_MS),
				headers: { Accept: "application/json" }
			});
			if (!currentResponse.ok && VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)) {throw new VeniceDiscoveryHttpError(currentResponse.status);}
			return currentResponse;
		}, {
			attempts: 3,
			minDelayMs: 300,
			maxDelayMs: 2e3,
			jitter: .2,
			label: "venice-model-discovery",
			shouldRetry: isRetryableVeniceDiscoveryError
		});
		if (!response.ok) {
			log$2.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
			return staticVeniceModelDefinitions();
		}
		const data = await response.json();
		if (!Array.isArray(data.data) || data.data.length === 0) {
			log$2.warn("No models found from API, using static catalog");
			return staticVeniceModelDefinitions();
		}
		const catalogById = new Map(VENICE_MODEL_CATALOG.map((m) => [m.id, m]));
		const models = [];
		for (const apiModel of data.data) {
			const catalogEntry = catalogById.get(apiModel.id);
			const apiMaxTokens = resolveApiMaxCompletionTokens({
				apiModel,
				knownMaxTokens: catalogEntry?.maxTokens
			});
			const apiSupportsTools = resolveApiSupportsTools(apiModel);
			if (catalogEntry) {
				const definition = buildVeniceModelDefinition(catalogEntry);
				if (apiMaxTokens !== void 0) {definition.maxTokens = apiMaxTokens;}
				if (apiSupportsTools === false) {definition.compat = {
					...definition.compat,
					supportsTools: false
				};}
				models.push(definition);
			} else {
				const apiSpec = apiModel.model_spec;
				const isReasoning = apiSpec?.capabilities?.supportsReasoning || apiModel.id.toLowerCase().includes("thinking") || apiModel.id.toLowerCase().includes("reason") || apiModel.id.toLowerCase().includes("r1");
				const hasVision = apiSpec?.capabilities?.supportsVision === true;
				models.push({
					id: apiModel.id,
					name: apiSpec?.name || apiModel.id,
					reasoning: isReasoning,
					input: hasVision ? ["text", "image"] : ["text"],
					cost: VENICE_DEFAULT_COST,
					contextWindow: normalizePositiveInt(apiSpec?.availableContextTokens) ?? VENICE_DEFAULT_CONTEXT_WINDOW,
					maxTokens: apiMaxTokens ?? VENICE_DEFAULT_MAX_TOKENS,
					compat: {
						supportsUsageInStreaming: false,
						...apiSupportsTools === false ? { supportsTools: false } : {}
					}
				});
			}
		}
		return models.length > 0 ? models : staticVeniceModelDefinitions();
	} catch (error) {
		if (error instanceof VeniceDiscoveryHttpError) {
			log$2.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
			return staticVeniceModelDefinitions();
		}
		log$2.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return staticVeniceModelDefinitions();
	}
}
//#endregion
//#region src/agents/vercel-ai-gateway.ts
const VERCEL_AI_GATEWAY_PROVIDER_ID = "vercel-ai-gateway";
const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
`${VERCEL_AI_GATEWAY_PROVIDER_ID}`;
const VERCEL_AI_GATEWAY_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const log$1 = createSubsystemLogger("agents/vercel-ai-gateway");
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
	}
];
function toPerMillionCost(value) {
	const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
	if (!Number.isFinite(numeric) || numeric < 0) {return 0;}
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
	if (!id) {return null;}
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
async function discoverVercelAiGatewayModels() {
	if (process.env.VITEST || false) {return getStaticVercelAiGatewayModelCatalog();}
	try {
		const response = await fetch(`${VERCEL_AI_GATEWAY_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) {
			log$1.warn(`Failed to discover Vercel AI Gateway models: HTTP ${response.status}`);
			return getStaticVercelAiGatewayModelCatalog();
		}
		const discovered = ((await response.json()).data ?? []).map(buildDiscoveredModelDefinition).filter((entry) => entry !== null);
		return discovered.length > 0 ? discovered : getStaticVercelAiGatewayModelCatalog();
	} catch (error) {
		log$1.warn(`Failed to discover Vercel AI Gateway models: ${String(error)}`);
		return getStaticVercelAiGatewayModelCatalog();
	}
}
//#endregion
//#region src/agents/models-config.providers.discovery.ts
const log = createSubsystemLogger("agents/model-providers");
const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_SHOW_MAX_MODELS = 200;
async function discoverOllamaModels(baseUrl, opts) {
	if (process.env.VITEST || false) {return [];}
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const response = await fetch(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(5e3) });
		if (!response.ok) {
			if (!opts?.quiet) {log.warn(`Failed to discover Ollama models: ${response.status}`);}
			return [];
		}
		const data = await response.json();
		if (!data.models || data.models.length === 0) {
			log.debug("No Ollama models found on local instance");
			return [];
		}
		const modelsToInspect = data.models.slice(0, OLLAMA_SHOW_MAX_MODELS);
		if (modelsToInspect.length < data.models.length && !opts?.quiet) {log.warn(`Capping Ollama /api/show inspection to ${OLLAMA_SHOW_MAX_MODELS} models (received ${data.models.length})`);}
		return (await enrichOllamaModelsWithContext(apiBase, modelsToInspect, { concurrency: OLLAMA_SHOW_CONCURRENCY })).map((model) => ({
			id: model.name,
			name: model.name,
			reasoning: isReasoningModelHeuristic(model.name),
			input: ["text"],
			cost: OLLAMA_DEFAULT_COST,
			contextWindow: model.contextWindow ?? 128e3,
			maxTokens: OLLAMA_DEFAULT_MAX_TOKENS
		}));
	} catch (error) {
		if (!opts?.quiet) {log.warn(`Failed to discover Ollama models: ${String(error)}`);}
		return [];
	}
}
async function discoverOpenAICompatibleLocalModels(params) {
	if (process.env.VITEST || false) {return [];}
	const url = `${params.baseUrl.trim().replace(/\/+$/, "")}/models`;
	try {
		const trimmedApiKey = params.apiKey?.trim();
		const response = await fetch(url, {
			headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : void 0,
			signal: AbortSignal.timeout(5e3)
		});
		if (!response.ok) {
			log.warn(`Failed to discover ${params.label} models: ${response.status}`);
			return [];
		}
		const models = (await response.json()).data ?? [];
		if (models.length === 0) {
			log.warn(`No ${params.label} models found on local instance`);
			return [];
		}
		return models.map((model) => ({ id: typeof model.id === "string" ? model.id.trim() : "" })).filter((model) => Boolean(model.id)).map((model) => {
			const modelId = model.id;
			return {
				id: modelId,
				name: modelId,
				reasoning: isReasoningModelHeuristic(modelId),
				input: ["text"],
				cost: SELF_HOSTED_DEFAULT_COST,
				contextWindow: params.contextWindow ?? 128e3,
				maxTokens: params.maxTokens ?? 8192
			};
		});
	} catch (error) {
		log.warn(`Failed to discover ${params.label} models: ${String(error)}`);
		return [];
	}
}
async function buildVeniceProvider() {
	return {
		baseUrl: VENICE_BASE_URL,
		api: "openai-completions",
		models: await discoverVeniceModels()
	};
}
async function buildOllamaProvider(configuredBaseUrl, opts) {
	const models = await discoverOllamaModels(configuredBaseUrl, opts);
	return {
		baseUrl: resolveOllamaApiBase(configuredBaseUrl),
		api: "ollama",
		models
	};
}
async function buildHuggingfaceProvider(discoveryApiKey) {
	const resolvedSecret = discoveryApiKey?.trim() ?? "";
	return {
		baseUrl: HUGGINGFACE_BASE_URL,
		api: "openai-completions",
		models: resolvedSecret !== "" ? await discoverHuggingfaceModels(resolvedSecret) : HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition)
	};
}
async function buildVercelAiGatewayProvider() {
	return {
		baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
		api: "anthropic-messages",
		models: await discoverVercelAiGatewayModels()
	};
}
async function buildVllmProvider(params) {
	const baseUrl = (params?.baseUrl?.trim() || "http://127.0.0.1:8000/v1").replace(/\/+$/, "");
	return {
		baseUrl,
		api: "openai-completions",
		models: await discoverOpenAICompatibleLocalModels({
			baseUrl,
			apiKey: params?.apiKey,
			label: VLLM_PROVIDER_LABEL
		})
	};
}
async function buildSglangProvider(params) {
	const baseUrl = (params?.baseUrl?.trim() || "http://127.0.0.1:30000/v1").replace(/\/+$/, "");
	return {
		baseUrl,
		api: "openai-completions",
		models: await discoverOpenAICompatibleLocalModels({
			baseUrl,
			apiKey: params?.apiKey,
			label: SGLANG_PROVIDER_LABEL
		})
	};
}
/**
* Build the Kilocode provider with dynamic model discovery from the gateway
* API. Falls back to the static catalog on failure.
*/
async function buildKilocodeProviderWithDiscovery() {
	return {
		baseUrl: KILOCODE_BASE_URL,
		api: "openai-completions",
		models: await discoverKilocodeModels()
	};
}
//#endregion
export { OLLAMA_DEFAULT_BASE_URL as S, buildHuggingfaceModelDefinition as _, buildVeniceProvider as a, fetchOllamaModels as b, VENICE_BASE_URL as c, buildVeniceModelDefinition as d, SELF_HOSTED_DEFAULT_CONTEXT_WINDOW as f, HUGGINGFACE_MODEL_CATALOG as g, HUGGINGFACE_BASE_URL as h, buildSglangProvider as i, VENICE_DEFAULT_MODEL_REF as l, SELF_HOSTED_DEFAULT_MAX_TOKENS as m, buildKilocodeProviderWithDiscovery as n, buildVercelAiGatewayProvider as o, SELF_HOSTED_DEFAULT_COST as p, buildOllamaProvider as r, buildVllmProvider as s, buildHuggingfaceProvider as t, VENICE_MODEL_CATALOG as u, buildOllamaModelDefinition as v, resolveOllamaApiBase as x, enrichOllamaModelsWithContext as y };
