import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import { l as resolveStateDir, r as init_paths } from "../../paths-CbmqEZIn.js";
import { n as init_subsystem, t as createSubsystemLogger } from "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../core-CUbPSeQH.js";
import "../../paths-DAoqckDF.js";
import "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import { c as resolveProxyFetchFromEnv } from "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import { g as buildOpenrouterProvider } from "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import { l as applyOpenrouterConfig, x as OPENROUTER_DEFAULT_MODEL_REF } from "../../onboard-auth.config-core-C8O7u8CI.js";
import "../../onboard-auth.models-DU-07n1Q.js";
import "../../onboard-auth.config-minimax-BZLhwFh4.js";
import "../../onboard-auth.config-opencode-CPtsorYE.js";
import "../../onboard-auth-D_nBXMz2.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-8PSAQte9.js";
import { i as isProxyReasoningUnsupported, n as createOpenRouterSystemCacheWrapper, r as createOpenRouterWrapper } from "../../proxy-stream-wrappers-DWMSrraJ.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
//#region src/agents/pi-embedded-runner/openrouter-model-capabilities.ts
/**
* Runtime OpenRouter model capability detection.
*
* When an OpenRouter model is not in the built-in static list, we look up its
* actual capabilities from a cached copy of the OpenRouter model catalog.
*
* Cache layers (checked in order):
* 1. In-memory Map (instant, cleared on process restart)
* 2. On-disk JSON file (<stateDir>/cache/openrouter-models.json)
* 3. OpenRouter API fetch (populates both layers)
*
* Model capabilities are assumed stable — the cache has no TTL expiry.
* A background refresh is triggered only when a model is not found in
* the cache (i.e. a newly added model on OpenRouter).
*
* Sync callers can read whatever is already cached. Async callers can await a
* one-time fetch so the first unknown-model lookup resolves with real
* capabilities instead of the text-only fallback.
*/
init_paths();
init_subsystem();
const log = createSubsystemLogger("openrouter-model-capabilities");
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 1e4;
const DISK_CACHE_FILENAME = "openrouter-models.json";
function resolveDiskCacheDir() {
	return join(resolveStateDir(), "cache");
}
function resolveDiskCachePath() {
	return join(resolveDiskCacheDir(), DISK_CACHE_FILENAME);
}
function writeDiskCache(map) {
	try {
		const cacheDir = resolveDiskCacheDir();
		if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
		const payload = { models: Object.fromEntries(map) };
		writeFileSync(resolveDiskCachePath(), JSON.stringify(payload), "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.debug(`Failed to write OpenRouter disk cache: ${message}`);
	}
}
function isValidCapabilities(value) {
	if (!value || typeof value !== "object") return false;
	const record = value;
	return typeof record.name === "string" && Array.isArray(record.input) && typeof record.reasoning === "boolean" && typeof record.contextWindow === "number" && typeof record.maxTokens === "number";
}
function readDiskCache() {
	try {
		const cachePath = resolveDiskCachePath();
		if (!existsSync(cachePath)) return;
		const raw = readFileSync(cachePath, "utf-8");
		const payload = JSON.parse(raw);
		if (!payload || typeof payload !== "object") return;
		const models = payload.models;
		if (!models || typeof models !== "object") return;
		const map = /* @__PURE__ */ new Map();
		for (const [id, caps] of Object.entries(models)) if (isValidCapabilities(caps)) map.set(id, caps);
		return map.size > 0 ? map : void 0;
	} catch {
		return;
	}
}
let cache;
let fetchInFlight;
const skipNextMissRefresh = /* @__PURE__ */ new Set();
function parseModel(model) {
	const input = ["text"];
	if (((model.architecture?.modality ?? model.modality ?? "").split("->")[0] ?? "").includes("image")) input.push("image");
	return {
		name: model.name || model.id,
		input,
		reasoning: model.supported_parameters?.includes("reasoning") ?? false,
		contextWindow: model.context_length || 128e3,
		maxTokens: model.top_provider?.max_completion_tokens ?? model.max_completion_tokens ?? model.max_output_tokens ?? 8192,
		cost: {
			input: parseFloat(model.pricing?.prompt || "0") * 1e6,
			output: parseFloat(model.pricing?.completion || "0") * 1e6,
			cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1e6,
			cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1e6
		}
	};
}
async function doFetch() {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await (resolveProxyFetchFromEnv() ?? globalThis.fetch)(OPENROUTER_MODELS_URL, { signal: controller.signal });
		if (!response.ok) {
			log.warn(`OpenRouter models API returned ${response.status}`);
			return;
		}
		const models = (await response.json()).data ?? [];
		const map = /* @__PURE__ */ new Map();
		for (const model of models) {
			if (!model.id) continue;
			map.set(model.id, parseModel(model));
		}
		cache = map;
		writeDiskCache(map);
		log.debug(`Cached ${map.size} OpenRouter models from API`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(`Failed to fetch OpenRouter models: ${message}`);
	} finally {
		clearTimeout(timeout);
	}
}
function triggerFetch() {
	if (fetchInFlight) return;
	fetchInFlight = doFetch().finally(() => {
		fetchInFlight = void 0;
	});
}
/**
* Ensure the cache is populated. Checks in-memory first, then disk, then
* triggers a background API fetch as a last resort.
* Does not block — returns immediately.
*/
function ensureOpenRouterModelCache() {
	if (cache) return;
	const disk = readDiskCache();
	if (disk) {
		cache = disk;
		log.debug(`Loaded ${disk.size} OpenRouter models from disk cache`);
		return;
	}
	triggerFetch();
}
/**
* Ensure capabilities for a specific model are available before first use.
*
* Known cached entries return immediately. Unknown entries wait for at most
* one catalog fetch, then leave sync resolution to read from the populated
* cache on the same request.
*/
async function loadOpenRouterModelCapabilities(modelId) {
	ensureOpenRouterModelCache();
	if (cache?.has(modelId)) return;
	let fetchPromise = fetchInFlight;
	if (!fetchPromise) {
		triggerFetch();
		fetchPromise = fetchInFlight;
	}
	await fetchPromise;
	if (!cache?.has(modelId)) skipNextMissRefresh.add(modelId);
}
/**
* Synchronously look up model capabilities from the cache.
*
* If a model is not found but the cache exists, a background refresh is
* triggered in case it's a newly added model not yet in the cache.
*/
function getOpenRouterModelCapabilities(modelId) {
	ensureOpenRouterModelCache();
	const result = cache?.get(modelId);
	if (!result && skipNextMissRefresh.delete(modelId)) return;
	if (!result && cache && !fetchInFlight) triggerFetch();
	return result;
}
//#endregion
//#region extensions/openrouter/index.ts
const PROVIDER_ID = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
	"anthropic/",
	"moonshot/",
	"moonshotai/",
	"zai/"
];
function buildDynamicOpenRouterModel(ctx) {
	const capabilities = getOpenRouterModelCapabilities(ctx.modelId);
	return {
		id: ctx.modelId,
		name: capabilities?.name ?? ctx.modelId,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: capabilities?.reasoning ?? false,
		input: capabilities?.input ?? ["text"],
		cost: capabilities?.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: capabilities?.contextWindow ?? 2e5,
		maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS
	};
}
function injectOpenRouterRouting(baseStreamFn, providerRouting) {
	if (!providerRouting) return baseStreamFn;
	return (model, context, options) => (baseStreamFn ?? ((nextModel, nextContext, nextOptions) => {
		throw new Error(`OpenRouter routing wrapper requires an underlying streamFn for ${String(nextModel.id)}.`);
	}))({
		...model,
		compat: {
			...model.compat,
			openRouterRouting: providerRouting
		}
	}, context, options);
}
function isOpenRouterCacheTtlModel(modelId) {
	return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
const openRouterPlugin = {
	id: "openrouter",
	name: "OpenRouter Provider",
	description: "Bundled OpenRouter provider plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerProvider({
			id: PROVIDER_ID,
			label: "OpenRouter",
			docsPath: "/providers/models",
			envVars: ["OPENROUTER_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "OpenRouter API key",
				hint: "API key",
				optionKey: "openrouterApiKey",
				flagName: "--openrouter-api-key",
				envVar: "OPENROUTER_API_KEY",
				promptMessage: "Enter OpenRouter API key",
				defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
				expectedProviders: ["openrouter"],
				applyConfig: (cfg) => applyOpenrouterConfig(cfg),
				wizard: {
					choiceId: "openrouter-api-key",
					choiceLabel: "OpenRouter API key",
					groupId: "openrouter",
					groupLabel: "OpenRouter",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...buildOpenrouterProvider(),
						apiKey
					} };
				}
			},
			resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
			prepareDynamicModel: async (ctx) => {
				await loadOpenRouterModelCapabilities(ctx.modelId);
			},
			capabilities: {
				openAiCompatTurnValidation: false,
				geminiThoughtSignatureSanitization: true,
				geminiThoughtSignatureModelHints: ["gemini"]
			},
			isModernModelRef: () => true,
			wrapStreamFn: (ctx) => {
				let streamFn = ctx.streamFn;
				const providerRouting = ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object" ? ctx.extraParams.provider : void 0;
				if (providerRouting) streamFn = injectOpenRouterRouting(streamFn, providerRouting);
				const openRouterThinkingLevel = ctx.modelId === "auto" || isProxyReasoningUnsupported(ctx.modelId) ? void 0 : ctx.thinkingLevel;
				streamFn = createOpenRouterWrapper(streamFn, openRouterThinkingLevel);
				streamFn = createOpenRouterSystemCacheWrapper(streamFn);
				return streamFn;
			},
			isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId)
		});
	}
};
//#endregion
export { openRouterPlugin as default };
