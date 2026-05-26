import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as fetchWithTimeout } from "./fetch-timeout-CptH2le9.js";
import { f as readProviderJsonArrayFieldResponse } from "./provider-http-errors-C90BH-le.js";
import "./runtime-env-BtvWnLRh.js";
import "./provider-http-CYBE-CBM.js";
import { n as buildManifestModelProviderConfig } from "./provider-catalog-shared-BLp5nwNN.js";
//#region extensions/deepinfra/openclaw.plugin.json
var modelCatalog = {
	"providers": { "deepinfra": {
		"baseUrl": "https://api.deepinfra.com/v1/openai",
		"api": "openai-completions",
		"models": [
			{
				"id": "deepseek-ai/DeepSeek-V3.2",
				"name": "DeepSeek V3.2",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 163840,
				"maxTokens": 163840,
				"cost": {
					"input": .26,
					"output": .38,
					"cacheRead": .13,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			},
			{
				"id": "zai-org/GLM-5.1",
				"name": "GLM-5.1",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 202752,
				"maxTokens": 202752,
				"cost": {
					"input": 1.05,
					"output": 3.5,
					"cacheRead": .205000005,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			},
			{
				"id": "stepfun-ai/Step-3.5-Flash",
				"name": "Step 3.5 Flash",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": .1,
					"output": .3,
					"cacheRead": .02,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			},
			{
				"id": "MiniMaxAI/MiniMax-M2.5",
				"name": "MiniMax M2.5",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 196608,
				"maxTokens": 196608,
				"cost": {
					"input": .15,
					"output": 1.15,
					"cacheRead": .03,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			},
			{
				"id": "moonshotai/Kimi-K2.5",
				"name": "Kimi K2.5",
				"reasoning": true,
				"input": ["text", "image"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": .45,
					"output": 2.25,
					"cacheRead": .070000002,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			},
			{
				"id": "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
				"name": "NVIDIA Nemotron 3 Super 120B A12B",
				"reasoning": true,
				"input": ["text"],
				"contextWindow": 262144,
				"maxTokens": 262144,
				"cost": {
					"input": .1,
					"output": .5,
					"cacheRead": 0,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			},
			{
				"id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
				"name": "Llama 3.3 70B Instruct Turbo",
				"reasoning": false,
				"input": ["text"],
				"contextWindow": 131072,
				"maxTokens": 131072,
				"cost": {
					"input": .1,
					"output": .32,
					"cacheRead": 0,
					"cacheWrite": 0
				},
				"compat": { "supportsUsageInStreaming": true }
			}
		]
	} },
	"discovery": { "deepinfra": "refreshable" }
};
//#endregion
//#region extensions/deepinfra/provider-models.ts
const log = createSubsystemLogger("deepinfra-models");
const DEEPINFRA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
	providerId: "deepinfra",
	catalog: modelCatalog.providers.deepinfra
});
const DEEPINFRA_BASE_URL = DEEPINFRA_MANIFEST_PROVIDER.baseUrl;
const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;
const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V3.2";
const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;
const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128e3;
const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;
const DEEPINFRA_MODEL_CATALOG = DEEPINFRA_MANIFEST_PROVIDER.models;
const DISCOVERY_TIMEOUT_MS = 5e3;
const DISCOVERY_CACHE_TTL_MS = 300 * 1e3;
let cachedModels = null;
let cachedAt = 0;
function resetDeepInfraModelCacheForTest() {
	cachedModels = null;
	cachedAt = 0;
}
function parseModality(metadata) {
	return metadata.tags?.includes("vision") ? ["text", "image"] : ["text"];
}
function parseReasoning(metadata) {
	return Boolean(metadata.tags?.includes("reasoning") || metadata.tags?.includes("reasoning_effort"));
}
function buildDeepInfraModelDefinition(model) {
	return {
		...model,
		compat: {
			...model.compat,
			supportsUsageInStreaming: model.compat?.supportsUsageInStreaming ?? true
		}
	};
}
function toModelDefinition(entry) {
	const metadata = entry.metadata;
	if (!metadata) throw new Error("missing metadata");
	return buildDeepInfraModelDefinition({
		id: entry.id,
		name: entry.id,
		reasoning: parseReasoning(metadata),
		input: parseModality(metadata),
		contextWindow: metadata.context_length ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
		maxTokens: metadata.max_tokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
		cost: {
			input: metadata.pricing?.input_tokens ?? 0,
			output: metadata.pricing?.output_tokens ?? 0,
			cacheRead: metadata.pricing?.cache_read_tokens ?? 0,
			cacheWrite: 0
		}
	});
}
function staticCatalog() {
	return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
}
function asDeepInfraModelEntry(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("DeepInfra model list: malformed JSON response");
	if (typeof value.id !== "string") throw new Error("DeepInfra model list: malformed JSON response");
	return value;
}
async function discoverDeepInfraModels() {
	if (process.env.VITEST) return staticCatalog();
	if (cachedModels && Date.now() - cachedAt < DISCOVERY_CACHE_TTL_MS) return [...cachedModels];
	try {
		const response = await fetchWithTimeout(DEEPINFRA_MODELS_URL, { headers: { Accept: "application/json" } }, DISCOVERY_TIMEOUT_MS);
		if (!response.ok) {
			log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
			return staticCatalog();
		}
		const data = await readProviderJsonArrayFieldResponse(response, "DeepInfra model list", "data");
		if (data.length === 0) {
			log.warn("No models found from DeepInfra API, using static catalog");
			return staticCatalog();
		}
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const rawEntry of data) {
			const entry = asDeepInfraModelEntry(rawEntry);
			const id = typeof entry?.id === "string" ? entry.id.trim() : "";
			if (!id || seen.has(id) || !entry.metadata) continue;
			try {
				models.push(toModelDefinition({
					...entry,
					id
				}));
				seen.add(id);
			} catch (error) {
				log.warn(`Skipping malformed model entry "${id}": ${String(error)}`);
			}
		}
		if (models.length === 0) return staticCatalog();
		cachedModels = models;
		cachedAt = Date.now();
		return [...models];
	} catch (error) {
		log.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return staticCatalog();
	}
}
//#endregion
export { DEEPINFRA_MODEL_CATALOG as a, resetDeepInfraModelCacheForTest as c, DEEPINFRA_MODELS_URL as i, DEEPINFRA_DEFAULT_MODEL_ID as n, buildDeepInfraModelDefinition as o, DEEPINFRA_DEFAULT_MODEL_REF as r, discoverDeepInfraModels as s, DEEPINFRA_BASE_URL as t };
