import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { a as OLLAMA_DEFAULT_MAX_TOKENS, i as OLLAMA_DEFAULT_COST, n as OLLAMA_DEFAULT_BASE_URL } from "./defaults-Ct4-oW82.js";
//#region extensions/ollama/src/provider-models.ts
const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;
const MAX_OLLAMA_SHOW_CACHE_ENTRIES = 256;
const ollamaModelShowInfoCache = /* @__PURE__ */ new Map();
const OLLAMA_ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);
function buildOllamaBaseUrlSsrFPolicy(baseUrl) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		if (OLLAMA_ALWAYS_BLOCKED_HOSTNAMES.has(parsed.hostname)) return;
		return {
			hostnameAllowlist: [parsed.hostname],
			allowPrivateNetwork: true
		};
	} catch {
		return;
	}
}
function resolveOllamaApiBase(configuredBaseUrl) {
	if (!configuredBaseUrl) return OLLAMA_DEFAULT_BASE_URL;
	return configuredBaseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}
function buildOllamaModelShowCacheKey(apiBase, model) {
	const version = model.digest?.trim() || model.modified_at?.trim();
	if (!version) return;
	return `${resolveOllamaApiBase(apiBase)}|${model.name}|${version}`;
}
function setOllamaModelShowCacheEntry(key, value) {
	if (ollamaModelShowInfoCache.size >= MAX_OLLAMA_SHOW_CACHE_ENTRIES) {
		const oldestKey = ollamaModelShowInfoCache.keys().next().value;
		if (typeof oldestKey === "string") ollamaModelShowInfoCache.delete(oldestKey);
	}
	ollamaModelShowInfoCache.set(key, value);
}
function hasCachedOllamaModelShowInfo(info) {
	return typeof info.contextWindow === "number" || (info.capabilities?.length ?? 0) > 0;
}
function parseOllamaNumCtxParameter(parameters) {
	if (typeof parameters !== "string" || !parameters.trim()) return;
	let lastValue;
	for (const rawLine of parameters.split(/\r?\n/)) {
		const match = rawLine.trim().match(/^num_ctx\s+(-?\d+)\b/);
		if (!match) continue;
		const parsed = Number.parseInt(match[1], 10);
		if (Number.isFinite(parsed) && parsed > 0) lastValue = parsed;
	}
	return lastValue;
}
async function queryOllamaModelShowInfo(apiBase, modelName) {
	const normalizedApiBase = resolveOllamaApiBase(apiBase);
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url: `${normalizedApiBase}/api/show`,
			init: {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: modelName }),
				signal: AbortSignal.timeout(3e3)
			},
			policy: buildOllamaBaseUrlSsrFPolicy(normalizedApiBase),
			auditContext: "ollama-provider-models.show"
		});
		try {
			if (!response.ok) return {};
			const data = await response.json();
			let contextWindow;
			if (data.model_info) {
				for (const [key, value] of Object.entries(data.model_info)) if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value)) {
					const ctx = Math.floor(value);
					if (ctx > 0) {
						contextWindow = ctx;
						break;
					}
				}
			}
			const paramCtx = parseOllamaNumCtxParameter(data.parameters);
			if (paramCtx !== void 0 && (contextWindow === void 0 || paramCtx > contextWindow)) contextWindow = paramCtx;
			const capabilities = Array.isArray(data.capabilities) ? data.capabilities.filter((c) => typeof c === "string") : void 0;
			return {
				contextWindow,
				capabilities
			};
		} finally {
			await release();
		}
	} catch {
		return {};
	}
}
async function queryOllamaModelShowInfoCached(apiBase, model) {
	const normalizedApiBase = resolveOllamaApiBase(apiBase);
	const cacheKey = buildOllamaModelShowCacheKey(normalizedApiBase, model);
	if (!cacheKey) return await queryOllamaModelShowInfo(normalizedApiBase, model.name);
	const cached = ollamaModelShowInfoCache.get(cacheKey);
	if (cached) return await cached;
	const pending = queryOllamaModelShowInfo(normalizedApiBase, model.name).then((result) => {
		if (!hasCachedOllamaModelShowInfo(result)) ollamaModelShowInfoCache.delete(cacheKey);
		return result;
	});
	setOllamaModelShowCacheEntry(cacheKey, pending);
	return await pending;
}
/** @deprecated Use queryOllamaModelShowInfo instead. */
async function queryOllamaContextWindow(apiBase, modelName) {
	return (await queryOllamaModelShowInfo(apiBase, modelName)).contextWindow;
}
async function enrichOllamaModelsWithContext(apiBase, models, opts) {
	const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
	const enriched = [];
	for (let index = 0; index < models.length; index += concurrency) {
		const batch = models.slice(index, index + concurrency);
		const batchResults = await Promise.all(batch.map(async (model) => {
			const showInfo = await queryOllamaModelShowInfoCached(apiBase, model);
			return Object.assign({}, model, {
				contextWindow: showInfo.contextWindow,
				capabilities: showInfo.capabilities
			});
		}));
		enriched.push(...batchResults);
	}
	return enriched;
}
function isReasoningModelHeuristic(modelId) {
	return /r1|reasoning|think|reason/i.test(modelId);
}
function isKnownOllamaCloudReasoningModel(modelId) {
	const normalized = modelId.trim().toLowerCase();
	return /^deepseek-v4-(?:flash|pro):cloud$/.test(normalized);
}
function buildOllamaModelDefinition(modelId, contextWindow, capabilities) {
	const input = capabilities?.includes("vision") ?? false ? ["text", "image"] : ["text"];
	const reasoning = isKnownOllamaCloudReasoningModel(modelId) || (capabilities === void 0 ? isReasoningModelHeuristic(modelId) : capabilities.includes("thinking"));
	const compat = capabilities === void 0 ? {
		supportsTools: true,
		supportsUsageInStreaming: true
	} : {
		supportsTools: capabilities.includes("tools"),
		supportsUsageInStreaming: true
	};
	return {
		id: modelId,
		name: modelId,
		reasoning,
		input,
		cost: OLLAMA_DEFAULT_COST,
		contextWindow: contextWindow ?? 128e3,
		maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
		compat
	};
}
async function fetchOllamaModels(baseUrl) {
	try {
		const apiBase = resolveOllamaApiBase(baseUrl);
		const { response, release } = await fetchWithSsrFGuard({
			url: `${apiBase}/api/tags`,
			init: { signal: AbortSignal.timeout(5e3) },
			policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
			auditContext: "ollama-provider-models.tags"
		});
		try {
			if (!response.ok) return {
				reachable: true,
				models: []
			};
			return {
				reachable: true,
				models: ((await response.json()).models ?? []).filter((m) => m.name)
			};
		} finally {
			await release();
		}
	} catch {
		return {
			reachable: false,
			models: []
		};
	}
}
async function buildOllamaProvider(configuredBaseUrl, opts) {
	const apiBase = resolveOllamaApiBase(configuredBaseUrl);
	const { reachable, models } = await fetchOllamaModels(apiBase);
	if (!reachable && !opts?.quiet) console.warn(`Ollama could not be reached at ${apiBase}.`);
	return {
		baseUrl: apiBase,
		api: "ollama",
		models: (await enrichOllamaModelsWithContext(apiBase, models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT))).map((model) => buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities))
	};
}
//#endregion
//#region extensions/ollama/src/provider-base-url.ts
function readProviderBaseUrl(provider) {
	if (!provider) return;
	if (Object.hasOwn(provider, "baseUrl") && typeof provider.baseUrl === "string" && provider.baseUrl.trim()) return provider.baseUrl.trim();
	const alternate = provider;
	if (Object.hasOwn(alternate, "baseURL") && typeof alternate.baseURL === "string" && alternate.baseURL.trim()) return alternate.baseURL.trim();
}
//#endregion
export { enrichOllamaModelsWithContext as a, queryOllamaContextWindow as c, buildOllamaProvider as i, queryOllamaModelShowInfo as l, buildOllamaBaseUrlSsrFPolicy as n, fetchOllamaModels as o, buildOllamaModelDefinition as r, isReasoningModelHeuristic as s, readProviderBaseUrl as t, resolveOllamaApiBase as u };
