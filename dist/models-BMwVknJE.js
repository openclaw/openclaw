import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { n as retryAsync } from "./retry-CryZAmlE.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/venice/openclaw.plugin.json
var modelCatalog = {
	"providers": { "venice": {
		"baseUrl": "https://api.venice.ai/api/v1",
		"api": "openai-completions",
		"models": [
			{
				"id": "llama-3.3-70b",
				"name": "Llama 3.3 70B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 4096,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "llama-3.2-3b",
				"name": "Llama 3.2 3B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 4096,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "hermes-3-llama-3.1-405b",
				"name": "Hermes 3 Llama 3.1 405B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": {
					"supportsUsageInStreaming": false,
					"supportsTools": false
				}
			},
			{
				"id": "qwen3-235b-a22b-thinking-2507",
				"name": "Qwen3 235B Thinking",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-235b-a22b-instruct-2507",
				"name": "Qwen3 235B Instruct",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-coder-480b-a35b-instruct",
				"name": "Qwen3 Coder 480B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-coder-480b-a35b-instruct-turbo",
				"name": "Qwen3 Coder 480B Turbo",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-5-35b-a3b",
				"name": "Qwen3.5 35B A3B",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-next-80b",
				"name": "Qwen3 Next 80B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-vl-235b-a22b",
				"name": "Qwen3 VL 235B (Vision)",
				"reasoning": false,
				"input": ["text", "image"],
				"contextWindow": 256e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "qwen3-4b",
				"name": "Venice Small (Qwen3 4B)",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 32e3,
				"maxTokens": 4096,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "deepseek-v3.2",
				"name": "DeepSeek V3.2",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 16e4,
				"maxTokens": 32768,
				"compat": {
					"supportsUsageInStreaming": false,
					"supportsTools": false
				}
			},
			{
				"id": "venice-uncensored",
				"name": "Venice Uncensored (Dolphin-Mistral)",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 32e3,
				"maxTokens": 4096,
				"compat": {
					"supportsUsageInStreaming": false,
					"supportsTools": false
				}
			},
			{
				"id": "mistral-31-24b",
				"name": "Venice Medium (Mistral)",
				"reasoning": false,
				"input": ["text", "image"],
				"contextWindow": 128e3,
				"maxTokens": 4096,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "google-gemma-3-27b-it",
				"name": "Google Gemma 3 27B Instruct",
				"reasoning": false,
				"input": ["text", "image"],
				"contextWindow": 198e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-oss-120b",
				"name": "OpenAI GPT OSS 120B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "nvidia-nemotron-3-nano-30b-a3b",
				"name": "NVIDIA Nemotron 3 Nano 30B",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "olafangensan-glm-4.7-flash-heretic",
				"name": "GLM 4.7 Flash Heretic",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 24e3,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "zai-org-glm-4.6",
				"name": "GLM 4.6",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 198e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "zai-org-glm-4.7",
				"name": "GLM 4.7",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 198e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "zai-org-glm-4.7-flash",
				"name": "GLM 4.7 Flash",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "zai-org-glm-5",
				"name": "GLM 5",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 198e3,
				"maxTokens": 32e3,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "kimi-k2-5",
				"name": "Kimi K2.5",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "kimi-k2-thinking",
				"name": "Kimi K2 Thinking",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "minimax-m21",
				"name": "MiniMax M2.1",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 198e3,
				"maxTokens": 32768,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "minimax-m25",
				"name": "MiniMax M2.5",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 198e3,
				"maxTokens": 32768,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "claude-opus-4-5",
				"name": "Claude Opus 4.5 (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 198e3,
				"maxTokens": 32768,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "claude-opus-4-6",
				"name": "Claude Opus 4.6 (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 1e6,
				"maxTokens": 128e3,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "claude-sonnet-4-5",
				"name": "Claude Sonnet 4.5 (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 198e3,
				"maxTokens": 64e3,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "claude-sonnet-4-6",
				"name": "Claude Sonnet 4.6 (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 1e6,
				"maxTokens": 64e3,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-52",
				"name": "GPT-5.2 (via Venice)",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-52-codex",
				"name": "GPT-5.2 Codex (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-53-codex",
				"name": "GPT-5.3 Codex (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 4e5,
				"maxTokens": 128e3,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-54",
				"name": "GPT-5.4 (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 1e6,
				"maxTokens": 131072,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-4o-2024-11-20",
				"name": "GPT-4o (via Venice)",
				"reasoning": false,
				"input": ["text", "image"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "openai-gpt-4o-mini-2024-07-18",
				"name": "GPT-4o Mini (via Venice)",
				"reasoning": false,
				"input": ["text", "image"],
				"contextWindow": 128e3,
				"maxTokens": 16384,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "gemini-3-pro-preview",
				"name": "Gemini 3 Pro (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 198e3,
				"maxTokens": 32768,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "gemini-3-1-pro-preview",
				"name": "Gemini 3.1 Pro (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 1e6,
				"maxTokens": 32768,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "gemini-3-flash-preview",
				"name": "Gemini 3 Flash (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 256e3,
				"maxTokens": 65536,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "grok-41-fast",
				"name": "Grok 4.1 Fast (via Venice)",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 1e6,
				"maxTokens": 3e4,
				"compat": { "supportsUsageInStreaming": false }
			},
			{
				"id": "grok-code-fast-1",
				"name": "Grok Code Fast 1 (via Venice)",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 256e3,
				"maxTokens": 1e4,
				"compat": { "supportsUsageInStreaming": false }
			}
		]
	} },
	"discovery": { "venice": "refreshable" }
};
//#endregion
//#region extensions/venice/models.ts
const log = createSubsystemLogger("venice-models");
const VENICE_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "venice",
	catalog: modelCatalog.providers.venice
});
const VENICE_BASE_URL = VENICE_MANIFEST_PROVIDER.baseUrl;
const VENICE_DEFAULT_MODEL_REF = `venice/kimi-k2-5`;
const VENICE_ALLOWED_HOSTNAMES = ["api.venice.ai"];
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
const VENICE_MODEL_CATALOG = VENICE_MANIFEST_PROVIDER.models;
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
			...entry.compat
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
		if (!current || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		const candidate = current;
		const code = typeof candidate.code === "string" ? candidate.code : typeof candidate.errno === "string" ? candidate.errno : void 0;
		if (code && VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES.has(code)) return true;
		if (candidate.cause) queue.push(candidate.cause);
		if (Array.isArray(candidate.errors)) queue.push(...candidate.errors);
	}
	return false;
}
function isRetryableVeniceDiscoveryError(err) {
	if (err instanceof VeniceDiscoveryHttpError) return true;
	if (err instanceof Error && err.name === "AbortError") return true;
	if (err instanceof TypeError && normalizeLowercaseStringOrEmpty(err.message) === "fetch failed") return true;
	return hasRetryableNetworkCode(err);
}
function normalizePositiveInt(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function resolveApiMaxCompletionTokens(params) {
	const raw = normalizePositiveInt(params.apiModel.model_spec?.maxCompletionTokens);
	if (!raw) return;
	const contextWindow = normalizePositiveInt(params.apiModel.model_spec?.availableContextTokens);
	const knownMaxTokens = typeof params.knownMaxTokens === "number" && Number.isFinite(params.knownMaxTokens) ? Math.floor(params.knownMaxTokens) : void 0;
	return Math.min(raw, contextWindow ?? knownMaxTokens ?? VENICE_DEFAULT_CONTEXT_WINDOW, knownMaxTokens ?? VENICE_DISCOVERY_HARD_MAX_TOKENS);
}
function resolveApiSupportsTools(apiModel) {
	const supportsFunctionCalling = apiModel.model_spec?.capabilities?.supportsFunctionCalling;
	return typeof supportsFunctionCalling === "boolean" ? supportsFunctionCalling : void 0;
}
async function discoverVeniceModels(options = {}) {
	if (process.env.VITEST) return staticVeniceModelDefinitions();
	try {
		const { response, release } = await retryAsync(async () => {
			const result = await fetchWithSsrFGuard({
				url: `${VENICE_BASE_URL}/models`,
				signal: AbortSignal.timeout(VENICE_DISCOVERY_TIMEOUT_MS),
				init: { headers: { Accept: "application/json" } },
				policy: { allowedHostnames: VENICE_ALLOWED_HOSTNAMES },
				auditContext: "venice-model-discovery"
			});
			const currentResponse = result.response;
			if (!currentResponse.ok && VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)) {
				await result.release();
				throw new VeniceDiscoveryHttpError(currentResponse.status);
			}
			return result;
		}, {
			attempts: 3,
			minDelayMs: options.retryDelayMs ?? 300,
			maxDelayMs: options.retryDelayMs ?? 2e3,
			jitter: options.retryDelayMs === void 0 ? .2 : 0,
			label: "venice-model-discovery",
			shouldRetry: isRetryableVeniceDiscoveryError
		});
		try {
			if (!response.ok) {
				log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
				return staticVeniceModelDefinitions();
			}
			const data = await response.json();
			if (!Array.isArray(data.data) || data.data.length === 0) {
				log.warn("No models found from API, using static catalog");
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
					if (apiMaxTokens !== void 0) definition.maxTokens = apiMaxTokens;
					if (apiSupportsTools === false) definition.compat = {
						...definition.compat,
						supportsTools: false
					};
					models.push(definition);
				} else {
					const apiSpec = apiModel.model_spec;
					const lowerModelId = normalizeLowercaseStringOrEmpty(apiModel.id);
					const isReasoning = apiSpec?.capabilities?.supportsReasoning || lowerModelId.includes("thinking") || lowerModelId.includes("reason") || lowerModelId.includes("r1");
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
		} finally {
			await release();
		}
	} catch (error) {
		if (error instanceof VeniceDiscoveryHttpError) {
			log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
			return staticVeniceModelDefinitions();
		}
		log.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return staticVeniceModelDefinitions();
	}
}
//#endregion
export { discoverVeniceModels as a, buildVeniceModelDefinition as i, VENICE_DEFAULT_MODEL_REF as n, VENICE_MODEL_CATALOG as r, VENICE_BASE_URL as t };
