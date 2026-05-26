import { c as normalizeOptionalString, p as resolvePrimaryStringValue } from "./string-coerce-DyL154ka.js";
import { i as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { d as isInstalledPluginEnabled } from "./installed-plugin-index-store-C1Oen9wR.js";
import { n as planManifestModelCatalogRows } from "./model-catalog-DtQLR692.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as buildModelAliasIndex, x as resolveModelRefFromString } from "./model-selection-shared-ClxdEp4X.js";
import { i as parseModelRef, n as modelKey, r as normalizeModelRef } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { a as getGatewayModelPricingCacheMeta, c as replaceGatewayModelPricingCache, n as clearGatewayModelPricingSourceFailure, r as getCachedGatewayModelPricing, s as recordGatewayModelPricingSourceFailure, t as clearGatewayModelPricingFailures } from "./model-pricing-cache-state-CABhovg9.js";
import { t as resolvePluginWebSearchConfig } from "./plugin-web-search-config-Dl--ok8y.js";
import { t as isGatewayModelPricingEnabled } from "./model-pricing-config-CpVOfxdS.js";
//#region src/gateway/model-pricing-cache.ts
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LITELLM_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 1440 * 6e4;
const FETCH_TIMEOUT_MS = 6e4;
const MAX_PRICING_CATALOG_BYTES = 5 * 1024 * 1024;
const log = createSubsystemLogger("gateway").child("model-pricing");
let refreshTimer = null;
let inFlightRefresh = null;
function clearRefreshTimer() {
	if (!refreshTimer) return;
	clearTimeout(refreshTimer);
	refreshTimer = null;
}
function getPricingModelNormalizationOptions(params) {
	const allowPluginBackedNormalization = params.config.plugins?.enabled !== false;
	return {
		allowManifestNormalization: allowPluginBackedNormalization,
		allowPluginNormalization: allowPluginBackedNormalization,
		...params.manifestRegistry ? { manifestPlugins: params.manifestRegistry.plugins } : {}
	};
}
function listLikeFallbacks(value) {
	if (!value || typeof value !== "object") return [];
	return Array.isArray(value.fallbacks) ? value.fallbacks.filter((entry) => typeof entry === "string").map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry)) : [];
}
function parseNumberString(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}
function formatTimeoutSeconds(timeoutMs) {
	const seconds = timeoutMs / 1e3;
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}
function readErrorName(error) {
	return error && typeof error === "object" && "name" in error ? String(error.name) : void 0;
}
function isTimeoutError(error) {
	if (readErrorName(error) === "TimeoutError") return true;
	return /\bTimeoutError\b/u.test(String(error));
}
function createPricingFetchSignal(signal) {
	const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
function formatPricingFetchFailure(source, error) {
	if (isTimeoutError(error)) return `${source} pricing fetch failed (timeout ${formatTimeoutSeconds(FETCH_TIMEOUT_MS)}): ${String(error)}`;
	return `${source} pricing fetch failed: ${String(error)}`;
}
function toPricePerMillion(value) {
	if (value === null || value < 0 || !Number.isFinite(value)) return 0;
	const scaled = value * 1e6;
	return Number.isFinite(scaled) ? scaled : 0;
}
function parseOpenRouterPricing(value) {
	if (!value || typeof value !== "object") return null;
	const pricing = value;
	const prompt = parseNumberString(pricing.prompt);
	const completion = parseNumberString(pricing.completion);
	if (prompt === null || completion === null) return null;
	return {
		input: toPricePerMillion(prompt),
		output: toPricePerMillion(completion),
		cacheRead: toPricePerMillion(parseNumberString(pricing.input_cache_read)),
		cacheWrite: toPricePerMillion(parseNumberString(pricing.input_cache_write))
	};
}
function toCachedPricingTier(value) {
	if (!value || typeof value !== "object") return null;
	const tier = value;
	const input = parseNumberString(tier.input);
	const output = parseNumberString(tier.output);
	const range = tier.range;
	if (input === null || output === null || !Array.isArray(range) || range.length < 1) return null;
	const start = parseNumberString(range[0]);
	if (start === null) return null;
	const rawEnd = range.length >= 2 ? parseNumberString(range[1]) : null;
	const end = rawEnd === null || rawEnd <= start ? Infinity : rawEnd;
	return {
		input,
		output,
		cacheRead: parseNumberString(tier.cacheRead) ?? 0,
		cacheWrite: parseNumberString(tier.cacheWrite) ?? 0,
		range: [start, end]
	};
}
function toCachedModelPricing(value) {
	if (!value || typeof value !== "object") return;
	const input = parseNumberString(value.input) ?? 0;
	const output = parseNumberString(value.output) ?? 0;
	const cacheRead = parseNumberString(value.cacheRead) ?? 0;
	const cacheWrite = parseNumberString(value.cacheWrite) ?? 0;
	const tieredPricing = Array.isArray(value.tieredPricing) ? value.tieredPricing.map((tier) => toCachedPricingTier(tier)).filter((tier) => Boolean(tier)).toSorted((left, right) => left.range[0] - right.range[0]) : [];
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...tieredPricing.length > 0 ? { tieredPricing } : {}
	};
}
async function readPricingJsonObject(response, source) {
	const contentLength = parseNumberString(response.headers.get("content-length"));
	if (contentLength !== null && contentLength > MAX_PRICING_CATALOG_BYTES) throw new Error(`${source} pricing response too large: ${contentLength} bytes`);
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_PRICING_CATALOG_BYTES) throw new Error(`${source} pricing response too large: ${buffer.byteLength} bytes`);
	let payload;
	try {
		payload = JSON.parse(Buffer.from(buffer).toString("utf8"));
	} catch {
		throw new Error(`${source} pricing response is malformed JSON`);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${source} pricing response is not a JSON object`);
	return payload;
}
function parseLiteLLMTieredPricing(tiers) {
	if (!Array.isArray(tiers) || tiers.length === 0) return;
	const result = [];
	for (const raw of tiers) {
		if (!raw || typeof raw !== "object") continue;
		const tier = raw;
		const inputPerToken = parseNumberString(tier.input_cost_per_token);
		const outputPerToken = parseNumberString(tier.output_cost_per_token);
		if (inputPerToken === null || outputPerToken === null) continue;
		const range = tier.range;
		if (!Array.isArray(range) || range.length < 1) continue;
		const start = parseNumberString(range[0]);
		if (start === null) continue;
		const rawEnd = range.length >= 2 ? parseNumberString(range[1]) : null;
		const end = rawEnd === null || rawEnd <= start ? Infinity : rawEnd;
		if (!Number.isFinite(inputPerToken) || !Number.isFinite(outputPerToken) || inputPerToken < 0 || outputPerToken < 0) continue;
		result.push({
			input: toPricePerMillion(inputPerToken),
			output: toPricePerMillion(outputPerToken),
			cacheRead: toPricePerMillion(parseNumberString(tier.cache_read_input_token_cost)),
			cacheWrite: toPricePerMillion(parseNumberString(tier.cache_creation_input_token_cost)),
			range: [start, end]
		});
	}
	return result.length > 0 ? result.toSorted((a, b) => a.range[0] - b.range[0]) : void 0;
}
function parseLiteLLMPricing(entry) {
	const inputPerToken = parseNumberString(entry.input_cost_per_token);
	const outputPerToken = parseNumberString(entry.output_cost_per_token);
	if (inputPerToken === null || outputPerToken === null) return null;
	const pricing = {
		input: toPricePerMillion(inputPerToken),
		output: toPricePerMillion(outputPerToken),
		cacheRead: toPricePerMillion(parseNumberString(entry.cache_read_input_token_cost)),
		cacheWrite: toPricePerMillion(parseNumberString(entry.cache_creation_input_token_cost))
	};
	const tieredPricing = parseLiteLLMTieredPricing(entry.tiered_pricing);
	if (tieredPricing) pricing.tieredPricing = tieredPricing;
	return pricing;
}
async function fetchLiteLLMPricingCatalog(fetchImpl, signal) {
	const response = await fetchImpl(LITELLM_PRICING_URL, {
		headers: { Accept: "application/json" },
		signal: createPricingFetchSignal(signal)
	});
	if (!response.ok) throw new Error(`LiteLLM pricing fetch failed: HTTP ${response.status}`);
	const payload = await readPricingJsonObject(response, "LiteLLM");
	const catalog = /* @__PURE__ */ new Map();
	for (const [key, value] of Object.entries(payload)) {
		if (!value || typeof value !== "object") continue;
		const pricing = parseLiteLLMPricing(value);
		if (!pricing) continue;
		catalog.set(key, pricing);
	}
	return catalog;
}
function normalizeExternalPricingSource(value, options) {
	if (!value) return;
	return {
		...value.provider ? { provider: normalizeModelRef(value.provider, "placeholder", options).provider } : {},
		...value.passthroughProviderModel ? { passthroughProviderModel: true } : {},
		modelIdTransforms: value.modelIdTransforms ?? []
	};
}
function normalizeExternalPricingPolicy(value, options) {
	if (!value) return;
	return {
		external: value.external !== false,
		...normalizeExternalPricingSource(value.openRouter, options) !== void 0 ? { openRouter: normalizeExternalPricingSource(value.openRouter, options) } : {},
		...normalizeExternalPricingSource(value.liteLLM, options) !== void 0 ? { liteLLM: normalizeExternalPricingSource(value.liteLLM, options) } : {}
	};
}
function filterActiveManifestRegistry(params) {
	return {
		diagnostics: params.registry.diagnostics,
		plugins: params.registry.plugins.filter((plugin) => isInstalledPluginEnabled(params.index, plugin.id, params.config))
	};
}
function resolveModelPricingManifestMetadata(params) {
	const metadataSnapshot = params.pluginMetadataSnapshot ?? params.pluginLookUpTable;
	if (metadataSnapshot) return {
		allRegistry: metadataSnapshot.manifestRegistry,
		activeRegistry: filterActiveManifestRegistry({
			registry: metadataSnapshot.manifestRegistry,
			index: metadataSnapshot.index,
			config: params.config
		})
	};
	if (params.manifestRegistry) return {
		allRegistry: params.manifestRegistry,
		activeRegistry: params.manifestRegistry
	};
	if (params.config.plugins?.enabled === false) {
		const emptyRegistry = {
			plugins: [],
			diagnostics: []
		};
		return {
			allRegistry: emptyRegistry,
			activeRegistry: emptyRegistry
		};
	}
	const snapshot = loadPluginMetadataSnapshot({
		config: params.config,
		env: params.env ?? process.env,
		...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}
	});
	return {
		allRegistry: snapshot.manifestRegistry,
		activeRegistry: filterActiveManifestRegistry({
			registry: snapshot.manifestRegistry,
			index: snapshot.index,
			config: params.config
		})
	};
}
function loadManifestPricingContext(registry, normalizationOptions) {
	const policies = /* @__PURE__ */ new Map();
	for (const plugin of registry.plugins) for (const [provider, rawPolicy] of Object.entries(plugin.modelPricing?.providers ?? {})) {
		const policy = normalizeExternalPricingPolicy(rawPolicy, normalizationOptions);
		if (policy) policies.set(provider, policy);
	}
	const catalogPricing = /* @__PURE__ */ new Map();
	for (const row of planManifestModelCatalogRows({ registry }).rows) {
		const pricing = toCachedModelPricing(row.cost);
		if (pricing) catalogPricing.set(modelKey(row.provider, row.id), pricing);
	}
	return {
		policies,
		catalogPricing
	};
}
function applyModelIdTransform(model, transform) {
	switch (transform) {
		case "version-dots": return model.replace(/^claude-(\d+)-(\d+)-/u, "claude-$1.$2-").replace(/^claude-([a-z]+)-(\d+)-(\d+)$/u, "claude-$1-$2.$3");
	}
	return model;
}
function applyModelIdTransforms(model, transforms) {
	const variants = new Set([model]);
	for (const transform of transforms) {
		const snapshot = Array.from(variants);
		for (const variant of snapshot) variants.add(applyModelIdTransform(variant, transform));
	}
	return [...variants];
}
function canonicalizeOpenRouterLookupId(id, options = {
	allowManifestNormalization: true,
	allowPluginNormalization: true
}) {
	const trimmed = id.trim();
	if (!trimmed) return "";
	const slash = trimmed.indexOf("/");
	if (slash === -1) return trimmed;
	const provider = normalizeModelRef(trimmed.slice(0, slash), "placeholder", {
		allowManifestNormalization: options.allowManifestNormalization,
		allowPluginNormalization: options.allowPluginNormalization,
		manifestPlugins: options.manifestPlugins
	}).provider;
	const model = trimmed.slice(slash + 1).trim();
	if (!model) return provider;
	const normalizedModel = normalizeModelRef(provider, model, {
		allowManifestNormalization: options.allowManifestNormalization,
		allowPluginNormalization: options.allowPluginNormalization,
		manifestPlugins: options.manifestPlugins
	}).model;
	return modelKey(provider, normalizedModel);
}
function buildExternalCatalogCandidates(params) {
	const { ref, source, policies } = params;
	const refKey = modelKey(ref.provider, ref.model);
	const seen = params.seen ?? /* @__PURE__ */ new Set();
	if (seen.has(refKey)) return [];
	const nextSeen = new Set(seen);
	nextSeen.add(refKey);
	const policy = policies.get(ref.provider);
	if (policy?.external === false) return [];
	const sourcePolicy = policy?.[source];
	if (sourcePolicy === void 0 && policy && source === "openRouter") return [];
	if (sourcePolicy === void 0 && policy && source === "liteLLM") return [];
	const provider = sourcePolicy?.provider ?? ref.provider;
	const transforms = sourcePolicy?.modelIdTransforms ?? [];
	const candidates = /* @__PURE__ */ new Set();
	for (const model of applyModelIdTransforms(ref.model, transforms)) {
		const candidate = modelKey(provider, model);
		candidates.add(source === "openRouter" ? canonicalizeOpenRouterLookupId(candidate, {
			allowManifestNormalization: params.allowManifestNormalization ?? true,
			allowPluginNormalization: params.allowPluginNormalization ?? true,
			manifestPlugins: params.manifestPlugins
		}) : candidate);
	}
	if (sourcePolicy?.passthroughProviderModel && ref.model.includes("/")) {
		const nestedRef = parseModelRef(ref.model, DEFAULT_PROVIDER, {
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (nestedRef) for (const candidate of buildExternalCatalogCandidates({
			ref: nestedRef,
			source,
			policies,
			seen: nextSeen,
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		})) candidates.add(candidate);
	}
	return Array.from(candidates).filter(Boolean);
}
function addResolvedModelRef(params) {
	const raw = params.raw?.trim();
	if (!raw) return;
	const resolved = resolveModelRefFromString({
		raw,
		defaultProvider: DEFAULT_PROVIDER,
		aliasIndex: params.aliasIndex,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	if (!resolved) return;
	const normalized = normalizeModelRef(resolved.ref.provider, resolved.ref.model, {
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	params.refs.set(modelKey(normalized.provider, normalized.model), normalized);
}
function addModelListLike(params) {
	addResolvedModelRef({
		raw: resolvePrimaryStringValue(params.value),
		aliasIndex: params.aliasIndex,
		refs: params.refs,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	for (const fallback of listLikeFallbacks(params.value)) addResolvedModelRef({
		raw: fallback,
		aliasIndex: params.aliasIndex,
		refs: params.refs,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
}
function addProviderModelPair(params) {
	const provider = params.provider?.trim();
	const model = params.model?.trim();
	if (!provider || !model) return;
	const normalized = normalizeModelRef(provider, model, {
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	params.refs.set(modelKey(normalized.provider, normalized.model), normalized);
}
function addConfiguredWebSearchPluginModels(params) {
	for (const pluginId of params.manifestRegistry.plugins.filter((plugin) => (plugin.contracts?.webSearchProviders ?? []).length > 0).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right))) addResolvedModelRef({
		raw: resolvePluginWebSearchConfig(params.config, pluginId)?.model,
		aliasIndex: params.aliasIndex,
		refs: params.refs,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
}
function isPrivateOrLoopbackHost(hostname) {
	const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
	if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:")) return true;
	if (host.startsWith("fc") || host.startsWith("fd")) return true;
	if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
	return /^172\.(1[6-9]|2\d|3[0-1])\./u.test(host) || host.startsWith("169.254.");
}
function isPrivateOrLoopbackBaseUrl(baseUrl) {
	if (!baseUrl) return false;
	try {
		return isPrivateOrLoopbackHost(new URL(baseUrl).hostname);
	} catch {
		return false;
	}
}
function findConfiguredProviderModel(config, ref, options = {
	allowManifestNormalization: true,
	allowPluginNormalization: true
}) {
	return (config.models?.providers?.[ref.provider])?.models?.find((model) => {
		const normalized = normalizeModelRef(ref.provider, model.id, {
			allowManifestNormalization: options.allowManifestNormalization,
			allowPluginNormalization: options.allowPluginNormalization,
			manifestPlugins: options.manifestPlugins
		});
		return modelKey(normalized.provider, normalized.model) === modelKey(ref.provider, ref.model);
	});
}
function getConfiguredModelPricing(config, ref, options = {
	allowManifestNormalization: true,
	allowPluginNormalization: true
}) {
	return toCachedModelPricing(findConfiguredProviderModel(config, ref, options)?.cost);
}
function hasPrivateOrLoopbackConfiguredEndpoint(config, ref, options = {
	allowManifestNormalization: true,
	allowPluginNormalization: true
}) {
	const providerConfig = config.models?.providers?.[ref.provider];
	return isPrivateOrLoopbackBaseUrl(findConfiguredProviderModel(config, ref, options)?.baseUrl) || isPrivateOrLoopbackBaseUrl(providerConfig?.baseUrl);
}
function shouldFetchExternalPricingForRef(params) {
	if (params.seededPricing.has(modelKey(params.ref.provider, params.ref.model))) return false;
	if (hasPrivateOrLoopbackConfiguredEndpoint(params.config, params.ref, {
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	})) return false;
	if (params.policies.get(params.ref.provider)?.external === false) return false;
	return true;
}
function filterExternalPricingRefs(params) {
	return params.refs.filter((ref) => shouldFetchExternalPricingForRef({
		config: params.config,
		ref,
		policies: params.policies,
		seededPricing: params.seededPricing,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	}));
}
function collectConfiguredModelPricingRefs(config, options = {}) {
	const manifestRegistry = options.manifestRegistry ?? resolveModelPricingManifestMetadata({ config }).allRegistry;
	const normalizationOptions = getPricingModelNormalizationOptions({
		config,
		manifestRegistry
	});
	const refs = /* @__PURE__ */ new Map();
	const normalizationParams = {
		allowManifestNormalization: normalizationOptions.allowManifestNormalization,
		allowPluginNormalization: normalizationOptions.allowPluginNormalization,
		...normalizationOptions.manifestPlugins ? { manifestPlugins: normalizationOptions.manifestPlugins } : {}
	};
	const aliasIndex = buildModelAliasIndex({
		cfg: config,
		defaultProvider: DEFAULT_PROVIDER,
		...normalizationParams
	});
	addModelListLike({
		value: config.agents?.defaults?.model,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addModelListLike({
		value: config.agents?.defaults?.subagents?.model,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addModelListLike({
		value: config.agents?.defaults?.imageModel,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addModelListLike({
		value: config.agents?.defaults?.pdfModel,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addResolvedModelRef({
		raw: config.agents?.defaults?.compaction?.model,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addResolvedModelRef({
		raw: config.agents?.defaults?.heartbeat?.model,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addResolvedModelRef({
		raw: config.messages?.tts?.summaryModel,
		aliasIndex,
		refs,
		...normalizationParams
	});
	addResolvedModelRef({
		raw: config.hooks?.gmail?.model,
		aliasIndex,
		refs,
		...normalizationParams
	});
	for (const agent of config.agents?.list ?? []) {
		addModelListLike({
			value: agent.model,
			aliasIndex,
			refs,
			...normalizationParams
		});
		addModelListLike({
			value: agent.subagents?.model,
			aliasIndex,
			refs,
			...normalizationParams
		});
		addResolvedModelRef({
			raw: agent.heartbeat?.model,
			aliasIndex,
			refs,
			...normalizationParams
		});
	}
	for (const mapping of config.hooks?.mappings ?? []) addResolvedModelRef({
		raw: mapping.model,
		aliasIndex,
		refs,
		...normalizationParams
	});
	for (const channelMap of Object.values(config.channels?.modelByChannel ?? {})) {
		if (!channelMap || typeof channelMap !== "object") continue;
		for (const raw of Object.values(channelMap)) addResolvedModelRef({
			raw: typeof raw === "string" ? raw : void 0,
			aliasIndex,
			refs,
			...normalizationParams
		});
	}
	addConfiguredWebSearchPluginModels({
		config,
		aliasIndex,
		refs,
		manifestRegistry,
		...normalizationParams
	});
	for (const entry of config.tools?.media?.models ?? []) addProviderModelPair({
		provider: entry.provider,
		model: entry.model,
		refs,
		...normalizationParams
	});
	for (const entry of config.tools?.media?.image?.models ?? []) addProviderModelPair({
		provider: entry.provider,
		model: entry.model,
		refs,
		...normalizationParams
	});
	for (const entry of config.tools?.media?.audio?.models ?? []) addProviderModelPair({
		provider: entry.provider,
		model: entry.model,
		refs,
		...normalizationParams
	});
	for (const entry of config.tools?.media?.video?.models ?? []) addProviderModelPair({
		provider: entry.provider,
		model: entry.model,
		refs,
		...normalizationParams
	});
	return Array.from(refs.values());
}
async function fetchOpenRouterPricingCatalog(fetchImpl, signal) {
	const response = await fetchImpl(OPENROUTER_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: createPricingFetchSignal(signal)
	});
	if (!response.ok) throw new Error(`OpenRouter /models failed: HTTP ${response.status}`);
	const payload = await readPricingJsonObject(response, "OpenRouter");
	const entries = Array.isArray(payload.data) ? payload.data : [];
	const catalog = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const obj = entry;
		const id = normalizeOptionalString(obj.id) ?? "";
		const pricing = parseOpenRouterPricing(obj.pricing);
		if (!id || !pricing) continue;
		catalog.set(id, {
			id,
			pricing
		});
	}
	return catalog;
}
function resolveCatalogPricingForRef(params) {
	const candidates = buildExternalCatalogCandidates({
		ref: params.ref,
		source: "openRouter",
		policies: params.policies,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	});
	for (const candidate of candidates) {
		const exact = params.catalogById.get(candidate);
		if (exact) return exact.pricing;
	}
	for (const candidate of candidates) {
		const normalized = canonicalizeOpenRouterLookupId(candidate, {
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (!normalized) continue;
		const match = params.catalogByNormalizedId.get(normalized);
		if (match) return match.pricing;
	}
}
function resolveLiteLLMPricingForRef(params) {
	for (const candidate of buildExternalCatalogCandidates({
		ref: params.ref,
		source: "liteLLM",
		policies: params.policies,
		allowManifestNormalization: params.allowManifestNormalization,
		allowPluginNormalization: params.allowPluginNormalization,
		manifestPlugins: params.manifestPlugins
	})) {
		const pricing = params.catalog.get(candidate);
		if (pricing) return pricing;
	}
}
function scheduleRefresh(params) {
	clearRefreshTimer();
	if (params.signal?.aborted) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		if (params.signal?.aborted) return;
		refreshGatewayModelPricingCache(params).catch((error) => {
			const message = `pricing refresh failed: ${String(error)}`;
			log.warn(message);
			if (!params.signal?.aborted) recordGatewayModelPricingSourceFailure("refresh", message);
		});
	}, CACHE_TTL_MS);
	refreshTimer.unref?.();
}
function collectSeededPricing(params) {
	const seeded = /* @__PURE__ */ new Map();
	for (const ref of params.refs) {
		const key = modelKey(ref.provider, ref.model);
		const configuredPricing = getConfiguredModelPricing(params.config, ref, {
			allowManifestNormalization: params.allowManifestNormalization,
			allowPluginNormalization: params.allowPluginNormalization,
			manifestPlugins: params.manifestPlugins
		});
		if (configuredPricing) {
			seeded.set(key, configuredPricing);
			continue;
		}
		const catalogPricing = params.catalogPricing.get(key);
		if (catalogPricing) seeded.set(key, catalogPricing);
	}
	return seeded;
}
async function refreshGatewayModelPricingCache(params) {
	if (!isGatewayModelPricingEnabled(params.config)) {
		clearRefreshTimer();
		clearGatewayModelPricingFailures();
		return;
	}
	if (params.signal?.aborted) return;
	if (inFlightRefresh) return await inFlightRefresh;
	const fetchImpl = params.fetchImpl ?? fetch;
	inFlightRefresh = (async () => {
		const manifestMetadata = resolveModelPricingManifestMetadata({
			config: params.config,
			env: params.env,
			workspaceDir: params.workspaceDir,
			pluginMetadataSnapshot: params.pluginMetadataSnapshot,
			pluginLookUpTable: params.pluginLookUpTable,
			manifestRegistry: params.manifestRegistry
		});
		const normalizationOptions = getPricingModelNormalizationOptions({
			config: params.config,
			manifestRegistry: manifestMetadata.allRegistry
		});
		const normalizationParams = {
			allowManifestNormalization: normalizationOptions.allowManifestNormalization,
			allowPluginNormalization: normalizationOptions.allowPluginNormalization,
			...normalizationOptions.manifestPlugins ? { manifestPlugins: normalizationOptions.manifestPlugins } : {}
		};
		const pricingContext = loadManifestPricingContext(manifestMetadata.activeRegistry, normalizationOptions);
		const allRefs = collectConfiguredModelPricingRefs(params.config, { manifestRegistry: manifestMetadata.allRegistry });
		const seededPricing = collectSeededPricing({
			config: params.config,
			refs: allRefs,
			catalogPricing: pricingContext.catalogPricing,
			...normalizationParams
		});
		const refs = filterExternalPricingRefs({
			config: params.config,
			refs: allRefs,
			policies: pricingContext.policies,
			seededPricing,
			...normalizationParams
		});
		if (refs.length === 0) {
			if (params.signal?.aborted) return;
			replaceGatewayModelPricingCache(seededPricing);
			clearGatewayModelPricingFailures();
			clearRefreshTimer();
			return;
		}
		let openRouterFailed = false;
		let litellmFailed = false;
		const [catalogById, litellmCatalog] = await Promise.all([fetchOpenRouterPricingCatalog(fetchImpl, params.signal).then((catalog) => {
			clearGatewayModelPricingSourceFailure("openrouter");
			return catalog;
		}).catch((error) => {
			const message = formatPricingFetchFailure("OpenRouter", error);
			log.warn(message);
			openRouterFailed = true;
			if (!params.signal?.aborted) recordGatewayModelPricingSourceFailure("openrouter", message);
			return /* @__PURE__ */ new Map();
		}), fetchLiteLLMPricingCatalog(fetchImpl, params.signal).then((catalog) => {
			clearGatewayModelPricingSourceFailure("litellm");
			return catalog;
		}).catch((error) => {
			const message = formatPricingFetchFailure("LiteLLM", error);
			log.warn(message);
			litellmFailed = true;
			if (!params.signal?.aborted) recordGatewayModelPricingSourceFailure("litellm", message);
			return /* @__PURE__ */ new Map();
		})]);
		if (params.signal?.aborted) return;
		const catalogByNormalizedId = /* @__PURE__ */ new Map();
		for (const entry of catalogById.values()) {
			const normalizedId = canonicalizeOpenRouterLookupId(entry.id, normalizationOptions);
			if (!normalizedId || catalogByNormalizedId.has(normalizedId)) continue;
			catalogByNormalizedId.set(normalizedId, entry);
		}
		const nextPricing = new Map(seededPricing);
		for (const ref of refs) {
			const openRouterPricing = resolveCatalogPricingForRef({
				ref,
				policies: pricingContext.policies,
				catalogById,
				catalogByNormalizedId,
				...normalizationParams
			});
			const litellmPricing = resolveLiteLLMPricingForRef({
				ref,
				policies: pricingContext.policies,
				catalog: litellmCatalog,
				...normalizationParams
			});
			if (openRouterPricing && litellmPricing?.tieredPricing) nextPricing.set(modelKey(ref.provider, ref.model), {
				...openRouterPricing,
				tieredPricing: litellmPricing.tieredPricing
			});
			else if (openRouterPricing) nextPricing.set(modelKey(ref.provider, ref.model), openRouterPricing);
			else if (litellmPricing) nextPricing.set(modelKey(ref.provider, ref.model), litellmPricing);
		}
		if (openRouterFailed || litellmFailed) {
			const existingMeta = getGatewayModelPricingCacheMeta();
			if (nextPricing.size === 0 && existingMeta.size > 0) {
				log.warn("Both pricing sources returned empty data — retaining existing cache");
				scheduleRefresh({
					...params,
					fetchImpl
				});
				return;
			}
			for (const ref of refs) {
				const key = modelKey(ref.provider, ref.model);
				if (!nextPricing.has(key)) {
					const existing = getCachedGatewayModelPricing({
						provider: ref.provider,
						model: ref.model
					});
					if (existing) nextPricing.set(key, existing);
				}
			}
		}
		if (params.signal?.aborted) return;
		clearGatewayModelPricingSourceFailure("bootstrap");
		clearGatewayModelPricingSourceFailure("refresh");
		replaceGatewayModelPricingCache(nextPricing);
		scheduleRefresh({
			...params,
			fetchImpl
		});
	})();
	try {
		await inFlightRefresh;
	} finally {
		inFlightRefresh = null;
	}
}
function startGatewayModelPricingRefresh(params) {
	if (!isGatewayModelPricingEnabled(params.config)) {
		clearRefreshTimer();
		clearGatewayModelPricingFailures();
		return () => {};
	}
	let stopped = false;
	const abortController = new AbortController();
	queueMicrotask(() => {
		if (stopped) return;
		refreshGatewayModelPricingCache({
			...params,
			signal: abortController.signal
		}).catch((error) => {
			const message = `pricing bootstrap failed: ${String(error)}`;
			log.warn(message);
			if (!abortController.signal.aborted) recordGatewayModelPricingSourceFailure("bootstrap", message);
		});
	});
	return () => {
		stopped = true;
		abortController.abort();
		clearRefreshTimer();
	};
}
//#endregion
export { refreshGatewayModelPricingCache as n, startGatewayModelPricingRefresh as r, collectConfiguredModelPricingRefs as t };
