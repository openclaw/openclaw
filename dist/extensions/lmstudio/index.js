import { t as createSubsystemLogger } from "../../subsystem-DSPWLoK5.js";
import { t as CUSTOM_LOCAL_AUTH_MARKER } from "../../model-auth-markers-Cf78z2Zm.js";
import { n as parseStandalonePlainTextToolCallBlocks } from "../../tool-payload-Gp3uQTKH.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "../../ssrf-DdDeGa5L.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../provider-auth-BtRKd5us.js";
import "../../ssrf-runtime-Be2o3zD7.js";
import "../../logging-core-DwEC9Ajh.js";
import { F as LMSTUDIO_PROVIDER_LABEL, P as LMSTUDIO_PROVIDER_ID, c as resolveLmstudioRuntimeApiKey, f as shouldUseLmstudioSyntheticAuth, g as normalizeLmstudioConfiguredCatalogEntries, n as ensureLmstudioModelLoaded, o as resolveLmstudioProviderHeaders, v as normalizeLmstudioProviderConfig, w as LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, y as resolveLmstudioInferenceBase } from "../../models.fetch-BJryONkH.js";
import { t as lmstudioMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-7qtHxZMB.js";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai";
//#region extensions/lmstudio/src/plain-text-tool-calls.ts
const MAX_PAYLOAD_CHARS = 256e3;
function parseLmstudioPlainTextToolCalls(text, allowedToolNames) {
	return parseStandalonePlainTextToolCallBlocks(text, {
		allowedToolNames,
		maxPayloadBytes: MAX_PAYLOAD_CHARS
	})?.map((block) => ({
		arguments: block.arguments,
		name: block.name
	})) ?? null;
}
function createLmstudioSyntheticToolCallId() {
	return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
//#endregion
//#region extensions/lmstudio/src/stream.ts
const log = createSubsystemLogger("extensions/lmstudio/stream");
const preloadInFlight = /* @__PURE__ */ new Map();
const preloadCooldown = /* @__PURE__ */ new Map();
const PRELOAD_BACKOFF_BASE_MS = 5e3;
const PRELOAD_BACKOFF_MAX_MS = 3e5;
function computePreloadBackoffMs(consecutiveFailures) {
	const raw = PRELOAD_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1);
	return Math.min(PRELOAD_BACKOFF_MAX_MS, raw);
}
function recordPreloadSuccess(preloadKey) {
	preloadCooldown.delete(preloadKey);
}
function recordPreloadFailure(preloadKey, now) {
	const consecutiveFailures = (preloadCooldown.get(preloadKey)?.consecutiveFailures ?? 0) + 1;
	const entry = {
		consecutiveFailures,
		untilMs: now + computePreloadBackoffMs(consecutiveFailures)
	};
	preloadCooldown.set(preloadKey, entry);
	return entry;
}
function isPreloadCoolingDown(preloadKey, now) {
	const entry = preloadCooldown.get(preloadKey);
	if (!entry) return;
	if (entry.untilMs <= now) {
		preloadCooldown.delete(preloadKey);
		return;
	}
	return entry;
}
function normalizeLmstudioModelKey(modelId) {
	const trimmed = modelId.trim();
	if (trimmed.toLowerCase().startsWith("lmstudio/")) return trimmed.slice(9).trim();
	return trimmed;
}
function resolveRequestedContextLength(model) {
	const withContextTokens = model;
	const contextTokens = typeof withContextTokens.contextTokens === "number" && Number.isFinite(withContextTokens.contextTokens) ? Math.floor(withContextTokens.contextTokens) : void 0;
	if (contextTokens && contextTokens > 0) return contextTokens;
	const contextWindow = typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) ? Math.floor(model.contextWindow) : void 0;
	if (contextWindow && contextWindow > 0) return contextWindow;
}
function resolveModelHeaders(model) {
	if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) return;
	return model.headers;
}
function toRecord(value) {
	return value && typeof value === "object" ? value : void 0;
}
function shouldPreloadLmstudioModels(value) {
	return toRecord(toRecord(value)?.params)?.preload !== false;
}
function withLmstudioUsageCompat(model) {
	return {
		...model,
		compat: {
			...model.compat && typeof model.compat === "object" ? model.compat : {},
			supportsUsageInStreaming: true
		}
	};
}
function resolveContextToolNames(context) {
	const tools = context.tools;
	if (!Array.isArray(tools)) return /* @__PURE__ */ new Set();
	const names = tools.map((tool) => {
		const record = toRecord(tool);
		return typeof record?.name === "string" && record.name.trim() ? record.name : void 0;
	}).filter((name) => Boolean(name));
	return new Set(names);
}
function couldStillBePlainTextToolCall(text) {
	if (text.length > 256e3) return false;
	const trimmed = text.trimStart();
	return trimmed.length === 0 || trimmed.startsWith("[") || trimmed.startsWith("<|channel|>") || trimmed.startsWith("commentary") || trimmed.startsWith("analysis") || trimmed.startsWith("final");
}
function createLmstudioToolCallBlock(parsed) {
	return {
		type: "toolCall",
		id: createLmstudioSyntheticToolCallId(),
		name: parsed.name,
		arguments: parsed.arguments,
		partialArgs: JSON.stringify(parsed.arguments)
	};
}
function promoteLmstudioPlainTextToolCalls(message, toolNames) {
	const messageRecord = toRecord(message);
	if (!messageRecord) return;
	if (!Array.isArray(messageRecord.content)) {
		if (typeof messageRecord.content !== "string" || !messageRecord.content.trim()) return;
		const parsed = parseLmstudioPlainTextToolCalls(messageRecord.content, toolNames);
		if (!parsed) return;
		return {
			...messageRecord,
			content: parsed.map(createLmstudioToolCallBlock),
			stopReason: "toolUse"
		};
	}
	if (messageRecord.content.some((block) => toRecord(block)?.type === "toolCall") || messageRecord.content.length === 0) return;
	let promoted = false;
	const nextContent = [];
	for (const block of messageRecord.content) {
		const blockRecord = toRecord(block);
		if (!blockRecord) return;
		if (blockRecord.type !== "text") {
			nextContent.push(blockRecord);
			continue;
		}
		const text = typeof blockRecord.text === "string" ? blockRecord.text : "";
		if (!text.trim()) continue;
		const parsed = parseLmstudioPlainTextToolCalls(text, toolNames);
		if (!parsed) return;
		nextContent.push(...parsed.map(createLmstudioToolCallBlock));
		promoted = true;
	}
	if (!promoted) return;
	return {
		...messageRecord,
		content: nextContent,
		stopReason: "toolUse"
	};
}
function emitPromotedToolCallEvents(stream, message) {
	(Array.isArray(message.content) ? message.content : []).forEach((block, contentIndex) => {
		const record = toRecord(block);
		if (record?.type !== "toolCall") return;
		stream.push({
			type: "toolcall_start",
			contentIndex,
			partial: message
		});
		stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: typeof record.partialArgs === "string" ? record.partialArgs : "{}",
			partial: message
		});
	});
}
function wrapLmstudioPlainTextToolCalls(source, context) {
	const toolNames = resolveContextToolNames(context);
	if (toolNames.size === 0) return source;
	const output = createAssistantMessageEventStream();
	const stream = output;
	(async () => {
		const bufferedTextEvents = [];
		let bufferedText = "";
		let ended = false;
		const endStream = () => {
			if (!ended) {
				ended = true;
				stream.end();
			}
		};
		const flushBufferedTextEvents = () => {
			for (const event of bufferedTextEvents.splice(0)) stream.push(event);
			bufferedText = "";
		};
		try {
			for await (const event of source) {
				const record = toRecord(event);
				const type = typeof record?.type === "string" ? record.type : "";
				if (type === "text_start" || type === "text_delta" || type === "text_end") {
					bufferedTextEvents.push(event);
					if (typeof record?.delta === "string") bufferedText += record.delta;
					else if (typeof record?.content === "string" && !bufferedText) bufferedText = record.content;
					if (!couldStillBePlainTextToolCall(bufferedText)) flushBufferedTextEvents();
					continue;
				}
				if (type === "done") {
					const promotedMessage = promoteLmstudioPlainTextToolCalls(record?.message, toolNames);
					if (promotedMessage) {
						bufferedTextEvents.splice(0);
						bufferedText = "";
						emitPromotedToolCallEvents(stream, promotedMessage);
						stream.push({
							...record,
							reason: "toolUse",
							message: promotedMessage
						});
					} else {
						flushBufferedTextEvents();
						stream.push(event);
					}
					endStream();
					return;
				}
				flushBufferedTextEvents();
				stream.push(event);
				if (type === "error") {
					endStream();
					return;
				}
			}
			flushBufferedTextEvents();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error)
				}
			});
		} finally {
			endStream();
		}
	})();
	return output;
}
function createPreloadKey(params) {
	return `${params.baseUrl}::${params.modelKey}::${params.requestedContextLength ?? "default"}`;
}
async function ensureLmstudioModelLoadedBestEffort(params) {
	const providerHeaders = {
		...(params.ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID])?.headers,
		...params.modelHeaders
	};
	const runtimeApiKey = typeof params.options?.apiKey === "string" && params.options.apiKey.trim().length > 0 ? params.options.apiKey.trim() : void 0;
	const headers = await resolveLmstudioProviderHeaders({
		config: params.ctx.config,
		headers: providerHeaders
	});
	const configuredApiKey = runtimeApiKey !== void 0 ? void 0 : await resolveLmstudioRuntimeApiKey({
		config: params.ctx.config,
		agentDir: params.ctx.agentDir,
		headers: providerHeaders
	});
	await ensureLmstudioModelLoaded({
		baseUrl: params.baseUrl,
		apiKey: runtimeApiKey ?? configuredApiKey,
		headers,
		ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
		modelKey: params.modelKey,
		requestedContextLength: params.requestedContextLength
	});
}
function wrapLmstudioInferencePreload(ctx) {
	const underlying = ctx.streamFn ?? streamSimple;
	return (model, context, options) => {
		if (model.provider !== "lmstudio") return underlying(model, context, options);
		const modelKey = normalizeLmstudioModelKey(model.id);
		if (!modelKey) return underlying(model, context, options);
		const providerConfig = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
		if (!shouldPreloadLmstudioModels(providerConfig)) {
			const stream = underlying(withLmstudioUsageCompat(model), context, options);
			return (async () => {
				return wrapLmstudioPlainTextToolCalls(stream instanceof Promise ? await stream : stream, context);
			})();
		}
		const providerBaseUrl = providerConfig?.baseUrl;
		const resolvedBaseUrl = resolveLmstudioInferenceBase(typeof model.baseUrl === "string" ? model.baseUrl : providerBaseUrl);
		const requestedContextLength = resolveRequestedContextLength(model);
		const preloadKey = createPreloadKey({
			baseUrl: resolvedBaseUrl,
			modelKey,
			requestedContextLength
		});
		const cooldownEntry = isPreloadCoolingDown(preloadKey, Date.now());
		const preloadPromise = preloadInFlight.get(preloadKey) ?? (cooldownEntry ? void 0 : (() => {
			const created = ensureLmstudioModelLoadedBestEffort({
				baseUrl: resolvedBaseUrl,
				modelKey,
				requestedContextLength,
				options,
				ctx,
				modelHeaders: resolveModelHeaders(model)
			}).then(() => {
				recordPreloadSuccess(preloadKey);
			}, (error) => {
				const entry = recordPreloadFailure(preloadKey, Date.now());
				throw Object.assign(/* @__PURE__ */ new Error("preload-failed"), {
					cause: error,
					consecutiveFailures: entry.consecutiveFailures,
					cooldownMs: entry.untilMs - Date.now()
				});
			}).finally(() => {
				preloadInFlight.delete(preloadKey);
			});
			preloadInFlight.set(preloadKey, created);
			return created;
		})());
		return (async () => {
			if (preloadPromise) try {
				await preloadPromise;
			} catch (error) {
				const annotated = error;
				const cause = annotated.cause ?? error;
				const failures = annotated.consecutiveFailures ?? 1;
				const cooldownSec = Math.max(0, Math.round((annotated.cooldownMs ?? 0) / 1e3));
				log.warn(`LM Studio inference preload failed for "${modelKey}" (${failures} consecutive failure${failures === 1 ? "" : "s"}, next preload attempt skipped for ~${cooldownSec}s); continuing without preload: ${String(cause)}`);
			}
			else if (cooldownEntry) log.debug(`LM Studio inference preload for "${modelKey}" skipped while backoff active (${cooldownEntry.consecutiveFailures} prior failures)`);
			const stream = underlying(withLmstudioUsageCompat(model), context, options);
			return wrapLmstudioPlainTextToolCalls(stream instanceof Promise ? await stream : stream, context);
		})();
	};
}
//#endregion
//#region extensions/lmstudio/index.ts
const PROVIDER_ID = "lmstudio";
const cachedDynamicModels = /* @__PURE__ */ new Map();
function resolveLmstudioAugmentedCatalogEntries(config) {
	if (!config) return [];
	return normalizeLmstudioConfiguredCatalogEntries(config.models?.providers?.lmstudio?.models).map((entry) => ({
		provider: PROVIDER_ID,
		id: entry.id,
		name: entry.name ?? entry.id,
		compat: {
			...entry.compat,
			supportsUsageInStreaming: true
		},
		contextWindow: entry.contextWindow,
		contextTokens: entry.contextTokens,
		reasoning: entry.reasoning,
		input: entry.input
	}));
}
/** Lazily loads setup helpers so provider wiring stays lightweight at startup. */
async function loadProviderSetup() {
	return await import("./api.js");
}
var lmstudio_default = definePluginEntry({
	id: PROVIDER_ID,
	name: "LM Studio Provider",
	description: "Bundled LM Studio provider plugin",
	register(api) {
		api.registerMemoryEmbeddingProvider(lmstudioMemoryEmbeddingProviderAdapter);
		api.registerProvider({
			id: PROVIDER_ID,
			label: "LM Studio",
			docsPath: "/providers/lmstudio",
			envVars: [LMSTUDIO_DEFAULT_API_KEY_ENV_VAR],
			auth: [{
				id: "custom",
				label: LMSTUDIO_PROVIDER_LABEL,
				hint: "Local/self-hosted LM Studio server",
				kind: "custom",
				run: async (ctx) => {
					return await (await loadProviderSetup()).promptAndConfigureLmstudioInteractive({
						config: ctx.config,
						agentDir: ctx.agentDir,
						prompter: ctx.prompter,
						secretInputMode: ctx.secretInputMode,
						allowSecretRefPrompt: ctx.allowSecretRefPrompt
					});
				},
				runNonInteractive: async (ctx) => {
					return await (await loadProviderSetup()).configureLmstudioNonInteractive(ctx);
				}
			}],
			catalog: {
				order: "late",
				run: async (ctx) => {
					return await (await loadProviderSetup()).discoverLmstudioProvider(ctx);
				}
			},
			resolveSyntheticAuth: ({ providerConfig }) => {
				if (!shouldUseLmstudioSyntheticAuth(providerConfig)) return;
				return {
					apiKey: CUSTOM_LOCAL_AUTH_MARKER,
					source: "models.providers.lmstudio (synthetic local key)",
					mode: "api-key"
				};
			},
			shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) => resolvedApiKey?.trim() === "lmstudio-local" || resolvedApiKey?.trim() === "custom-local",
			normalizeConfig: ({ providerConfig }) => normalizeLmstudioProviderConfig(providerConfig),
			prepareDynamicModel: async (ctx) => {
				const providerSetup = await loadProviderSetup();
				cachedDynamicModels.set(ctx.providerConfig?.baseUrl ?? "", await providerSetup.prepareLmstudioDynamicModels(ctx));
			},
			resolveDynamicModel: (ctx) => cachedDynamicModels.get(ctx.providerConfig?.baseUrl ?? "")?.find((model) => model.id === ctx.modelId),
			augmentModelCatalog: (ctx) => resolveLmstudioAugmentedCatalogEntries(ctx.config),
			wrapStreamFn: wrapLmstudioInferencePreload,
			wizard: {
				setup: {
					choiceId: PROVIDER_ID,
					choiceLabel: "LM Studio",
					choiceHint: "Local/self-hosted LM Studio server",
					groupId: PROVIDER_ID,
					groupLabel: "LM Studio",
					groupHint: "Self-hosted open-weight models",
					methodId: "custom"
				},
				modelPicker: {
					label: "LM Studio (custom)",
					hint: "Detect models from LM Studio /api/v1/models",
					methodId: "custom"
				}
			}
		});
	}
});
//#endregion
export { lmstudio_default as default };
