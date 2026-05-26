import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as privateFileStoreSync } from "./private-file-store-DMtyjgoc.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as resolveProxyFetchFromEnv } from "./proxy-fetch-B02LTFkt.js";
import { _ as resolveOpenAIFastMode, a as createCodexNativeWebSearchWrapper, b as createMinimaxFastModeWrapper, d as createOpenAIReasoningCompatibilityWrapper, f as createOpenAIResponsesContextManagementWrapper, g as createOpenAIThinkingLevelWrapper, h as createOpenAITextVerbosityWrapper, i as isProxyReasoningUnsupported, m as createOpenAIStringContentWrapper, o as createOpenAIAttributionHeadersWrapper, p as createOpenAIServiceTierWrapper, r as createOpenRouterWrapper, t as createKilocodeWrapper, u as createOpenAIFastModeWrapper, v as resolveOpenAIServiceTier, y as resolveOpenAITextVerbosity } from "./proxy-stream-wrappers-B-pawBvX.js";
import { n as resolveMoonshotThinkingKeep, r as resolveMoonshotThinkingType, t as createMoonshotThinkingWrapper } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import { i as createGoogleThinkingPayloadWrapper, y as createToolStreamWrapper } from "./provider-stream-shared-jI_a6bxx.js";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai";
//#region src/agents/pi-embedded-runner/anthropic-family-tool-payload-compat.ts
function hasOpenAiAnthropicToolPayloadCompatFlag(model) {
	if (!model.compat || typeof model.compat !== "object" || Array.isArray(model.compat)) return false;
	return model.compat.requiresOpenAiAnthropicToolPayload === true;
}
function requiresAnthropicToolPayloadCompatibilityForModel(model, options) {
	if (model.api !== "anthropic-messages") return false;
	return Boolean(options?.toolSchemaMode || options?.toolChoiceMode) || hasOpenAiAnthropicToolPayloadCompatFlag(model);
}
function usesOpenAiFunctionAnthropicToolSchemaForModel(model, options) {
	return options?.toolSchemaMode === "openai-functions" || hasOpenAiAnthropicToolPayloadCompatFlag(model);
}
function usesOpenAiStringModeAnthropicToolChoiceForModel(model, options) {
	return options?.toolChoiceMode === "openai-string-modes" || hasOpenAiAnthropicToolPayloadCompatFlag(model);
}
function normalizeOpenAiFunctionAnthropicToolDefinition(tool) {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return;
	const toolObj = tool;
	if (toolObj.function && typeof toolObj.function === "object") return toolObj;
	const rawName = normalizeOptionalString(toolObj.name) ?? "";
	if (!rawName) return toolObj;
	const functionSpec = {
		name: rawName,
		parameters: toolObj.input_schema && typeof toolObj.input_schema === "object" ? toolObj.input_schema : toolObj.parameters && typeof toolObj.parameters === "object" ? toolObj.parameters : {
			type: "object",
			properties: {}
		}
	};
	if (typeof toolObj.description === "string" && toolObj.description.trim()) functionSpec.description = toolObj.description;
	if (typeof toolObj.strict === "boolean") functionSpec.strict = toolObj.strict;
	return {
		type: "function",
		function: functionSpec
	};
}
function normalizeOpenAiStringModeAnthropicToolChoice(toolChoice) {
	if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return toolChoice;
	const choice = toolChoice;
	if (choice.type === "auto") return "auto";
	if (choice.type === "none") return "none";
	if (choice.type === "required" || choice.type === "any") return "required";
	if (choice.type === "tool" && typeof choice.name === "string" && choice.name.trim()) return {
		type: "function",
		function: { name: choice.name.trim() }
	};
	return toolChoice;
}
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
function createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn, options) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, streamOptions) => {
		const originalOnPayload = streamOptions?.onPayload;
		return underlying(model, context, {
			...streamOptions,
			onPayload: (payload) => {
				if (payload && typeof payload === "object" && requiresAnthropicToolPayloadCompatibilityForModel(model, options)) {
					const payloadObj = payload;
					if (Array.isArray(payloadObj.tools) && usesOpenAiFunctionAnthropicToolSchemaForModel(model, options)) payloadObj.tools = payloadObj.tools.map((tool) => normalizeOpenAiFunctionAnthropicToolDefinition(tool)).filter((tool) => !!tool);
					if (usesOpenAiStringModeAnthropicToolChoiceForModel(model, options)) payloadObj.tool_choice = normalizeOpenAiStringModeAnthropicToolChoice(payloadObj.tool_choice);
				}
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
function createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn) {
	return createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn, {
		toolSchemaMode: "openai-functions",
		toolChoiceMode: "openai-string-modes"
	});
}
//#endregion
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
const log = createSubsystemLogger("openrouter-model-capabilities");
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 1e4;
const DISK_CACHE_FILENAME = "openrouter-models.json";
const DISK_CACHE_VERSION = 2;
function resolveDiskCacheDir() {
	return join(resolveStateDir(), "cache");
}
function resolveDiskCachePath() {
	return join(resolveDiskCacheDir(), DISK_CACHE_FILENAME);
}
function writeDiskCache(map) {
	try {
		const cachePath = resolveDiskCachePath();
		const payload = {
			version: DISK_CACHE_VERSION,
			models: Object.fromEntries(map)
		};
		privateFileStoreSync(dirname(cachePath)).writeJson(basename(cachePath), payload);
	} catch (err) {
		const message = formatErrorMessage(err);
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
		const cachePayload = payload;
		if (cachePayload.version !== DISK_CACHE_VERSION) return;
		const models = cachePayload.models;
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
	const supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : void 0;
	return {
		name: model.name || model.id,
		input,
		reasoning: supportedParameters?.includes("reasoning") ?? false,
		...supportedParameters ? { supportsTools: supportedParameters.includes("tools") } : {},
		contextWindow: model.context_length || 128e3,
		maxTokens: model.top_provider?.max_completion_tokens ?? model.max_completion_tokens ?? model.max_output_tokens ?? 8192,
		cost: {
			input: Number.parseFloat(model.pricing?.prompt || "0") * 1e6,
			output: Number.parseFloat(model.pricing?.completion || "0") * 1e6,
			cacheRead: Number.parseFloat(model.pricing?.input_cache_read || "0") * 1e6,
			cacheWrite: Number.parseFloat(model.pricing?.input_cache_write || "0") * 1e6
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
		const message = formatErrorMessage(err);
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
*
* @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
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
*
* @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
*/
function getOpenRouterModelCapabilities(modelId) {
	ensureOpenRouterModelCache();
	const result = cache?.get(modelId);
	if (!result && skipNextMissRefresh.delete(modelId)) return;
	if (!result && cache && !fetchInFlight) triggerFetch();
	return result;
}
//#endregion
//#region src/plugin-sdk/provider-stream.ts
function buildProviderStreamFamilyHooks(family) {
	switch (family) {
		case "google-thinking": return { wrapStreamFn: (ctx) => createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel) };
		case "moonshot-thinking": return { wrapStreamFn: (ctx) => {
			const thinkingType = resolveMoonshotThinkingType({
				configuredThinking: ctx.extraParams?.thinking,
				thinkingLevel: ctx.thinkingLevel
			});
			const thinkingKeep = resolveMoonshotThinkingKeep({ configuredThinking: ctx.extraParams?.thinking });
			return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType, thinkingKeep);
		} };
		case "kilocode-thinking": return { wrapStreamFn: (ctx) => {
			const thinkingLevel = ctx.modelId === "kilo/auto" || isProxyReasoningUnsupported(ctx.modelId) ? void 0 : ctx.thinkingLevel;
			return createKilocodeWrapper(ctx.streamFn, thinkingLevel);
		} };
		case "minimax-fast-mode": return { wrapStreamFn: (ctx) => createMinimaxFastModeWrapper(ctx.streamFn, ctx.extraParams?.fastMode === true) };
		case "openai-responses-defaults": return { wrapStreamFn: (ctx) => {
			let nextStreamFn = createOpenAIAttributionHeadersWrapper(ctx.streamFn);
			if (resolveOpenAIFastMode(ctx.extraParams)) nextStreamFn = createOpenAIFastModeWrapper(nextStreamFn);
			const serviceTier = resolveOpenAIServiceTier(ctx.extraParams);
			if (serviceTier) nextStreamFn = createOpenAIServiceTierWrapper(nextStreamFn, serviceTier);
			const textVerbosity = resolveOpenAITextVerbosity(ctx.extraParams);
			if (textVerbosity) nextStreamFn = createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
			nextStreamFn = createCodexNativeWebSearchWrapper(nextStreamFn, {
				config: ctx.config,
				agentDir: ctx.agentDir
			});
			nextStreamFn = createOpenAIStringContentWrapper(nextStreamFn);
			return createOpenAIResponsesContextManagementWrapper(createOpenAIReasoningCompatibilityWrapper(createOpenAIThinkingLevelWrapper(nextStreamFn, ctx.thinkingLevel)), ctx.extraParams);
		} };
		case "openrouter-thinking": return { wrapStreamFn: (ctx) => {
			const thinkingLevel = ctx.modelId === "auto" || isProxyReasoningUnsupported(ctx.modelId) ? void 0 : ctx.thinkingLevel;
			return createOpenRouterWrapper(ctx.streamFn, thinkingLevel, ctx.extraParams);
		} };
		case "tool-stream-default-on": return { wrapStreamFn: (ctx) => createToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false) };
	}
	throw new Error("Unsupported provider stream family");
}
/** @deprecated Google provider-owned stream hook shortcut; use local provider hooks instead. */
const GOOGLE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("google-thinking");
/** @deprecated Kilocode provider-owned stream hook shortcut; use local provider hooks instead. */
const KILOCODE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("kilocode-thinking");
/** @deprecated Moonshot provider-owned stream hook shortcut; use local provider hooks instead. */
const MOONSHOT_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("moonshot-thinking");
/** @deprecated MiniMax provider-owned stream hook shortcut; use local provider hooks instead. */
const MINIMAX_FAST_MODE_STREAM_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");
/** @deprecated OpenAI provider-owned stream hook shortcut; use local provider hooks instead. */
const OPENAI_RESPONSES_STREAM_HOOKS = buildProviderStreamFamilyHooks("openai-responses-defaults");
/** @deprecated OpenRouter provider-owned stream hook shortcut; use local provider hooks instead. */
const OPENROUTER_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("openrouter-thinking");
/** @deprecated Provider-owned stream hook shortcut; use local provider hooks instead. */
const TOOL_STREAM_DEFAULT_ON_HOOKS = buildProviderStreamFamilyHooks("tool-stream-default-on");
//#endregion
export { OPENAI_RESPONSES_STREAM_HOOKS as a, buildProviderStreamFamilyHooks as c, createAnthropicToolPayloadCompatibilityWrapper as d, createOpenAIAnthropicToolPayloadCompatibilityWrapper as f, MOONSHOT_THINKING_STREAM_HOOKS as i, getOpenRouterModelCapabilities as l, KILOCODE_THINKING_STREAM_HOOKS as n, OPENROUTER_THINKING_STREAM_HOOKS as o, MINIMAX_FAST_MODE_STREAM_HOOKS as r, TOOL_STREAM_DEFAULT_ON_HOOKS as s, GOOGLE_THINKING_STREAM_HOOKS as t, loadOpenRouterModelCapabilities as u };
