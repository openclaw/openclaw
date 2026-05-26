import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { i as getCachedLiveCatalogValue } from "./provider-catalog-shared-BLp5nwNN.js";
import { t as OPENROUTER_BASE_URL } from "./provider-catalog-Dya4CIwt.js";
import { t as fetchOpenRouterVideoGet } from "./video-http-Hj22Aav3.js";
//#region extensions/openrouter/video-model-catalog.ts
const DEFAULT_HTTP_TIMEOUT_MS = 6e4;
function normalizeStringArray(value) {
	return Array.isArray(value) ? value.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry)) : [];
}
function normalizeNumberArray(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "number" && Number.isFinite(entry)) : [];
}
function normalizeResolutionArray(value) {
	return normalizeStringArray(value).map((entry) => entry.toUpperCase());
}
function normalizeFrameImageRoles(value) {
	const seen = /* @__PURE__ */ new Set();
	for (const entry of normalizeStringArray(value)) if (entry === "first_frame" || entry === "last_frame") seen.add(entry);
	return [...seen];
}
function normalizeStringRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = {};
	for (const [key, raw] of Object.entries(value)) {
		const normalized = normalizeOptionalString(raw);
		if (normalized) record[key] = normalized;
	}
	return Object.keys(record).length > 0 ? record : void 0;
}
function buildOpenRouterVideoModelCapabilities(model) {
	const aspectRatios = normalizeStringArray(model.supported_aspect_ratios);
	const durations = normalizeNumberArray(model.supported_durations);
	const frameImages = normalizeFrameImageRoles(model.supported_frame_images);
	const resolutions = normalizeResolutionArray(model.supported_resolutions);
	const sizes = normalizeStringArray(model.supported_sizes);
	const allowedPassthroughParameters = normalizeStringArray(model.allowed_passthrough_parameters);
	const audioSupport = typeof model.generate_audio === "boolean" ? { supportsAudio: model.generate_audio } : {};
	const capabilities = {
		providerOptions: {
			callback_url: "string",
			seed: "number"
		},
		generate: {
			maxVideos: 1,
			...durations.length > 0 ? { supportedDurationSeconds: durations } : {},
			...aspectRatios.length > 0 ? {
				supportsAspectRatio: true,
				aspectRatios
			} : {},
			...resolutions.length > 0 ? {
				supportsResolution: true,
				resolutions
			} : {},
			...sizes.length > 0 ? {
				supportsSize: true,
				sizes
			} : {},
			...audioSupport
		},
		imageToVideo: {
			enabled: frameImages.length > 0,
			maxVideos: 1,
			...frameImages.length > 0 ? { maxInputImages: frameImages.length } : {},
			...durations.length > 0 ? { supportedDurationSeconds: durations } : {},
			...aspectRatios.length > 0 ? {
				supportsAspectRatio: true,
				aspectRatios
			} : {},
			...resolutions.length > 0 ? {
				supportsResolution: true,
				resolutions
			} : {},
			...sizes.length > 0 ? {
				supportsSize: true,
				sizes
			} : {},
			...audioSupport
		},
		videoToVideo: { enabled: false }
	};
	const canonicalSlug = normalizeOptionalString(model.canonical_slug);
	if (canonicalSlug) capabilities.canonicalSlug = canonicalSlug;
	const description = normalizeOptionalString(model.description);
	if (description) capabilities.description = description;
	if (typeof model.created === "number" && Number.isFinite(model.created)) capabilities.created = model.created;
	const pricingSkus = normalizeStringRecord(model.pricing_skus);
	if (pricingSkus) capabilities.pricingSkus = pricingSkus;
	if (allowedPassthroughParameters.length > 0) capabilities.allowedPassthroughParameters = allowedPassthroughParameters;
	return capabilities;
}
function projectOpenRouterVideoModelsToCatalogEntries(payload) {
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const model of payload.data ?? []) {
		const id = normalizeOptionalString(model.id);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const entry = {
			kind: "video_generation",
			provider: "openrouter",
			model: id,
			source: "live",
			capabilities: buildOpenRouterVideoModelCapabilities(model)
		};
		const name = normalizeOptionalString(model.name);
		if (name) entry.label = name;
		entries.push(entry);
	}
	return entries;
}
async function fetchOpenRouterVideoModels(params) {
	return await getCachedLiveCatalogValue({
		keyParts: [
			"openrouter",
			"video-models",
			params.baseUrl,
			params.apiKey
		],
		load: async () => {
			const headers = new Headers({
				Authorization: `Bearer ${params.apiKey}`,
				"HTTP-Referer": "https://openclaw.ai",
				"X-OpenRouter-Title": "OpenClaw"
			});
			const { response, release } = await fetchOpenRouterVideoGet({
				url: "videos/models",
				baseUrl: params.baseUrl,
				headers,
				timeoutMs: params.timeoutMs,
				allowPrivateNetwork: params.allowPrivateNetwork,
				dispatcherPolicy: params.dispatcherPolicy,
				auditContext: "openrouter-video-models"
			});
			try {
				await assertOkOrThrowHttpError(response, "OpenRouter video models request failed");
				return await response.json();
			} finally {
				await release();
			}
		}
	});
}
async function listOpenRouterVideoModelCatalog(ctx) {
	const { discoveryApiKey: apiKey } = ctx.resolveProviderApiKey("openrouter");
	if (!apiKey) return null;
	const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		provider: "openrouter",
		capability: "video",
		baseUrl: ctx.config.models?.providers?.openrouter?.baseUrl,
		defaultBaseUrl: OPENROUTER_BASE_URL
	});
	return projectOpenRouterVideoModelsToCatalogEntries(await fetchOpenRouterVideoModels({
		baseUrl,
		apiKey,
		timeoutMs: ctx.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
		allowPrivateNetwork,
		dispatcherPolicy
	}));
}
async function resolveOpenRouterVideoModelCapabilities(ctx) {
	const auth = await resolveApiKeyForProvider({
		provider: "openrouter",
		cfg: ctx.cfg,
		agentDir: ctx.agentDir,
		store: ctx.authStore
	});
	if (!auth.apiKey) return;
	const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		provider: "openrouter",
		capability: "video",
		baseUrl: ctx.cfg?.models?.providers?.openrouter?.baseUrl,
		defaultBaseUrl: OPENROUTER_BASE_URL
	});
	return projectOpenRouterVideoModelsToCatalogEntries(await fetchOpenRouterVideoModels({
		baseUrl,
		apiKey: auth.apiKey,
		timeoutMs: ctx.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
		allowPrivateNetwork,
		dispatcherPolicy
	})).find((entry) => entry.model === ctx.model)?.capabilities;
}
//#endregion
export { resolveOpenRouterVideoModelCapabilities as n, listOpenRouterVideoModelCatalog as t };
