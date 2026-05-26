import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { E as buildGuardedModelFetch, _ as mergeTransportHeaders, b as transformTransportMessages, f as coerceTransportToolCallArguments, g as finalizeTransportStream, h as failTransportStream, m as createWritableTransportEventStream, p as createEmptyTransportUsage, y as sanitizeTransportPayloadText } from "./openai-transport-stream-Pgx5hpN7.js";
import { o as createProviderHttpError } from "./provider-http-errors-C90BH-le.js";
import { i as stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-T51pGsv9.js";
import { _ as stripInvalidGoogleThinkingBudget, d as isGoogleGemini3ProModel, h as resolveGoogleGemini3ThinkingLevel, l as isGoogleGemini25ThinkingBudgetModel, u as isGoogleGemini3FlashModel } from "./provider-stream-shared-jI_a6bxx.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-http-CYBE-CBM.js";
import "./provider-transport-runtime-Be6VrgOg.js";
import "./thinking-api-Cziq3sR-.js";
import { r as normalizeGoogleApiBaseUrl } from "./provider-policy-C3QGAGLZ.js";
import { t as parseGeminiAuth } from "./gemini-auth-BjLpmB9U.js";
import { i as resolveGoogleVertexAuthorizedUserHeaders, n as isGoogleVertexCredentialsMarker } from "./vertex-adc--LQQpRFG.js";
import { calculateCost, getEnvApiKey } from "@earendil-works/pi-ai";
//#region extensions/google/transport-stream.ts
const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS = 45e3;
const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV = "OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS";
const GOOGLE_VERTEX_DEFAULT_API_VERSION = "v1";
let toolCallCounter = 0;
const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";
function normalizeOptionalString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function requiresToolCallId(modelId) {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}
function requiresToolCallThoughtSignature(modelId) {
	return normalizeLowercaseStringOrEmpty(modelId).includes("gemini-3");
}
function supportsMultimodalFunctionResponse(modelId) {
	const match = normalizeLowercaseStringOrEmpty(modelId).match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return true;
	return Number.parseInt(match[1] ?? "", 10) >= 3;
}
function retainThoughtSignature(existing, incoming) {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}
function stableStringifyGoogleToolCallValue(value) {
	if (Array.isArray(value)) return `[${value.map((item) => stableStringifyGoogleToolCallValue(item)).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value;
		return `{${Object.keys(record).toSorted().map((key) => `${JSON.stringify(key)}:${stableStringifyGoogleToolCallValue(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
function isJsonLikeThoughtSignature(value) {
	const trimmed = value.trim();
	return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("\":") || trimmed.includes("\",\"") || trimmed.includes("\"type\"");
}
const GEMINI_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GEMINI_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;
function hasGeminiThoughtSignatureTruncationFootprint(value) {
	return GEMINI_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) || GEMINI_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0;
}
function sanitizeGeminiThoughtSignature(thoughtSignature) {
	if (typeof thoughtSignature !== "string") return;
	const trimmed = thoughtSignature.trim();
	if (!trimmed) return;
	if (isJsonLikeThoughtSignature(trimmed)) return;
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered === "reasoning" || lowered === normalizeLowercaseStringOrEmpty(GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP)) return;
	if (hasGeminiThoughtSignatureTruncationFootprint(trimmed)) return;
	return trimmed;
}
function isSameGoogleTransportRoute(source, model) {
	return source.provider === model.provider && normalizeGoogleTransportRouteApi(source.api) === normalizeGoogleTransportRouteApi(model.api) && source.model === model.id;
}
function normalizeGoogleTransportRouteApi(api) {
	switch (api) {
		case "google-generative-ai":
		case "openclaw-google-generative-ai-transport": return "google-generative-ai";
		case "google-vertex": return "google-vertex";
		default: return;
	}
}
function normalizeGoogleTransportModelRoute(model) {
	const api = normalizeGoogleTransportRouteApi(model.api);
	return api && api !== model.api ? Object.assign({}, model, { api }) : model;
}
function normalizeGoogleTransportMessageRoutes(messages) {
	return messages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const api = normalizeGoogleTransportRouteApi(msg.api);
		return api && api !== msg.api ? Object.assign({}, msg, { api }) : msg;
	});
}
function toolCallThoughtSignatureReplayKey(block) {
	return [
		block.id,
		block.name,
		stableStringifyGoogleToolCallValue(coerceTransportToolCallArguments(block.arguments))
	].join("\0");
}
function mapToolChoice(choice) {
	if (!choice) return;
	if (typeof choice === "object" && choice.type === "function") return {
		mode: "ANY",
		allowedFunctionNames: [choice.function.name]
	};
	switch (choice) {
		case "none": return { mode: "NONE" };
		case "any":
		case "required": return { mode: "ANY" };
		default: return { mode: "AUTO" };
	}
}
function mapStopReasonString(reason) {
	switch (reason) {
		case "STOP": return "stop";
		case "MAX_TOKENS": return "length";
		default: return "error";
	}
}
function normalizeToolCallId(id) {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function resolveGoogleModelPath(modelId) {
	if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) return modelId;
	return `models/${modelId}`;
}
function buildGoogleGenerativeAiRequestUrl(model) {
	return `${normalizeGoogleApiBaseUrl(model.baseUrl)}/${resolveGoogleModelPath(model.id)}:streamGenerateContent?alt=sse`;
}
function resolveGoogleVertexProject(options) {
	const project = normalizeOptionalString(options?.project) || normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) || normalizeOptionalString(process.env.GCLOUD_PROJECT);
	if (!project) throw new Error("Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.");
	return project;
}
function resolveGoogleVertexLocation(options) {
	const location = normalizeOptionalString(options?.location) || normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
	if (!location) throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	return location;
}
function resolveGoogleVertexBaseOrigin(model, location) {
	const configured = normalizeOptionalString(model.baseUrl);
	if (configured && !configured.includes("{location}")) try {
		const url = new URL(configured);
		url.pathname = "";
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/u, "");
	} catch {
		return configured.replace(/\/+$/u, "");
	}
	if (location === "global") return "https://aiplatform.googleapis.com";
	return `https://${location}-aiplatform.googleapis.com`;
}
function buildGoogleVertexRequestUrl(model, options) {
	const project = encodeURIComponent(resolveGoogleVertexProject(options));
	const location = encodeURIComponent(resolveGoogleVertexLocation(options));
	const modelId = encodeURIComponent(model.id);
	return `${resolveGoogleVertexBaseOrigin(model, decodeURIComponent(location))}/${GOOGLE_VERTEX_DEFAULT_API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;
}
function resolveThinkingLevel(level, modelId) {
	const resolved = resolveGoogleGemini3ThinkingLevel({
		modelId,
		thinkingLevel: level
	});
	if (resolved) return resolved;
	throw new Error("Unsupported thinking level");
}
function resolveExplicitThinkingLevel(level, modelId) {
	return resolveGoogleGemini3ThinkingLevel({
		modelId,
		thinkingLevel: level.toLowerCase()
	}) ?? level;
}
function getDisabledThinkingConfig(modelId) {
	const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
		modelId,
		thinkingLevel: "off"
	});
	if (thinkingLevel) return { thinkingLevel };
	return normalizeGoogleThinkingConfig(modelId, { thinkingBudget: 0 });
}
function getGoogleThinkingBudget(modelId, effort, customBudgets) {
	const normalizedEffort = effort === "xhigh" ? "high" : effort;
	if (customBudgets?.[normalizedEffort] !== void 0) return customBudgets[normalizedEffort];
	if (modelId.includes("2.5-pro")) return {
		minimal: 128,
		low: 2048,
		medium: 8192,
		high: 32768
	}[normalizedEffort];
	if (modelId.includes("2.5-flash-lite")) return {
		minimal: 512,
		low: 2048,
		medium: 8192,
		high: 24576
	}[normalizedEffort];
	if (modelId.includes("2.5-flash")) return {
		minimal: 128,
		low: 2048,
		medium: 8192,
		high: 24576
	}[normalizedEffort];
}
function isAdaptiveReasoningLevel(value) {
	return value === "adaptive";
}
function resolveGoogleThinkingConfig(model, options) {
	if (!model.reasoning) return;
	if (options?.thinking) {
		if (!options.thinking.enabled) return getDisabledThinkingConfig(model.id);
		const config = { includeThoughts: true };
		if (options.thinking.level) config.thinkingLevel = resolveExplicitThinkingLevel(options.thinking.level, model.id);
		else if (typeof options.thinking.budgetTokens === "number") {
			const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
				modelId: model.id,
				thinkingBudget: options.thinking.budgetTokens
			});
			if (thinkingLevel) config.thinkingLevel = thinkingLevel;
			else config.thinkingBudget = options.thinking.budgetTokens;
		}
		return normalizeGoogleThinkingConfig(model.id, config);
	}
	if (!options?.reasoning) return getDisabledThinkingConfig(model.id);
	if (isAdaptiveReasoningLevel(options.reasoning)) {
		if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) return { includeThoughts: true };
		if (isGoogleGemini25ThinkingBudgetModel(model.id)) return normalizeGoogleThinkingConfig(model.id, {
			includeThoughts: true,
			thinkingBudget: -1
		});
	}
	if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) return {
		includeThoughts: true,
		thinkingLevel: resolveThinkingLevel(options.reasoning, model.id)
	};
	const budget = getGoogleThinkingBudget(model.id, options.reasoning, options.thinkingBudgets);
	return normalizeGoogleThinkingConfig(model.id, {
		includeThoughts: true,
		...typeof budget === "number" ? { thinkingBudget: budget } : {}
	});
}
function normalizeGoogleThinkingConfig(modelId, thinkingConfig) {
	stripInvalidGoogleThinkingBudget({
		thinkingConfig,
		modelId
	});
	return Object.keys(thinkingConfig).length > 0 ? thinkingConfig : void 0;
}
function convertGoogleMessages(model, context) {
	const contents = [];
	const replayToolCallThoughtSignatures = /* @__PURE__ */ new Map();
	const shouldReplayToolCallThoughtSignature = requiresToolCallThoughtSignature(model.id);
	const routeModel = normalizeGoogleTransportModelRoute(model);
	const transformedMessages = transformTransportMessages(normalizeGoogleTransportMessageRoutes(context.messages), routeModel, (id) => requiresToolCallId(model.id) ? normalizeToolCallId(id) : id, { preserveCrossModelToolCallThoughtSignature: requiresToolCallThoughtSignature(model.id) });
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeTransportPayloadText(msg.content) || " " }]
				});
				continue;
			}
			const parts = msg.content.map((item) => item.type === "text" ? { text: sanitizeTransportPayloadText(item.text) || " " } : { inlineData: {
				mimeType: item.mimeType,
				data: item.data
			} }).filter((item) => model.input.includes("image") || !("inlineData" in item));
			if (parts.length === 0) parts.push({ text: " " });
			contents.push({
				role: "user",
				parts
			});
			continue;
		}
		if (msg.role === "assistant") {
			const isSameRoute = isSameGoogleTransportRoute(msg, model);
			const parts = [];
			const nextReplayToolCallThoughtSignatures = /* @__PURE__ */ new Map();
			for (const block of msg.content) {
				if (block.type === "text") {
					if (!block.text.trim()) continue;
					const sanitizedTextSignature = isSameRoute ? sanitizeGeminiThoughtSignature(block.textSignature) : void 0;
					parts.push({
						text: sanitizeTransportPayloadText(block.text),
						...sanitizedTextSignature ? { thoughtSignature: sanitizedTextSignature } : {}
					});
					continue;
				}
				if (block.type === "thinking") {
					if (!block.thinking.trim()) continue;
					if (isSameRoute) {
						const sanitizedThinkingSignature = sanitizeGeminiThoughtSignature(block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeTransportPayloadText(block.thinking),
							...sanitizedThinkingSignature ? { thoughtSignature: sanitizedThinkingSignature } : {}
						});
					} else parts.push({ text: sanitizeTransportPayloadText(block.thinking) });
					continue;
				}
				if (block.type === "toolCall") {
					const replayKey = toolCallThoughtSignatureReplayKey(block);
					const replayedThoughtSignature = shouldReplayToolCallThoughtSignature && isSameRoute ? replayToolCallThoughtSignatures.get(replayKey) : void 0;
					const ownSignature = isSameRoute ? sanitizeGeminiThoughtSignature(block.thoughtSignature) : void 0;
					if (ownSignature) nextReplayToolCallThoughtSignatures.set(replayKey, ownSignature);
					const thoughtSignature = ownSignature ?? replayedThoughtSignature ?? (shouldReplayToolCallThoughtSignature ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP : void 0);
					parts.push({
						functionCall: {
							name: block.name,
							args: coerceTransportToolCallArguments(block.arguments),
							...requiresToolCallId(model.id) ? { id: block.id } : {}
						},
						...thoughtSignature ? { thoughtSignature } : {}
					});
				}
			}
			for (const [key, signature] of nextReplayToolCallThoughtSignatures) replayToolCallThoughtSignatures.set(key, signature);
			if (parts.length > 0) contents.push({
				role: "model",
				parts
			});
			continue;
		}
		if (msg.role === "toolResult") {
			const textResult = msg.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
			const imageContent = model.input.includes("image") ? msg.content.filter((item) => item.type === "image") : [];
			const responseValue = textResult ? sanitizeTransportPayloadText(textResult) : imageContent.length > 0 ? "(see attached image)" : "";
			const imageParts = imageContent.map((imageBlock) => ({ inlineData: {
				mimeType: imageBlock.mimeType,
				data: imageBlock.data
			} }));
			const functionResponse = { functionResponse: {
				name: msg.toolName,
				response: msg.isError ? { error: responseValue } : { output: responseValue },
				...supportsMultimodalFunctionResponse(model.id) && imageParts.length > 0 ? { parts: imageParts } : {},
				...requiresToolCallId(model.id) ? { id: msg.toolCallId } : {}
			} };
			const last = contents[contents.length - 1];
			if (last?.role === "user" && Array.isArray(last.parts) && last.parts.some((part) => "functionResponse" in part)) last.parts.push(functionResponse);
			else contents.push({
				role: "user",
				parts: [functionResponse]
			});
			if (imageParts.length > 0 && !supportsMultimodalFunctionResponse(model.id)) contents.push({
				role: "user",
				parts: [{ text: "Tool result image:" }, ...imageParts]
			});
		}
	}
	if (contents.length === 0) contents.push({
		role: "user",
		parts: [{ text: " " }]
	});
	return contents;
}
function convertGoogleTools(tools) {
	if (tools.length === 0) return;
	return [{ functionDeclarations: tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parametersJsonSchema: tool.parameters
	})) }];
}
function buildGoogleGenerativeAiParams(model, context, options) {
	const generationConfig = {};
	if (typeof options?.temperature === "number") generationConfig.temperature = options.temperature;
	if (typeof options?.maxTokens === "number") generationConfig.maxOutputTokens = options.maxTokens;
	const thinkingConfig = resolveGoogleThinkingConfig(model, options);
	if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
	const params = { contents: convertGoogleMessages(model, context) };
	if (typeof options?.cachedContent === "string" && options.cachedContent.trim()) params.cachedContent = options.cachedContent.trim();
	if (Object.keys(generationConfig).length > 0) params.generationConfig = generationConfig;
	if (context.systemPrompt) params.systemInstruction = { parts: [{ text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)) }] };
	if (context.tools?.length) {
		params.tools = convertGoogleTools(context.tools);
		const toolChoice = mapToolChoice(options?.toolChoice);
		if (toolChoice) params.toolConfig = { functionCallingConfig: toolChoice };
	}
	return params;
}
function buildGoogleHeaders(model, apiKey, optionHeaders) {
	return mergeTransportHeaders({
		"Content-Type": "application/json",
		accept: "text/event-stream"
	}, apiKey ? parseGeminiAuth(apiKey).headers : void 0, model.headers, optionHeaders) ?? {
		"Content-Type": "application/json",
		accept: "text/event-stream"
	};
}
async function buildGoogleVertexHeaders(model, apiKey, optionHeaders, fetchImpl) {
	return mergeTransportHeaders({
		"Content-Type": "application/json",
		accept: "text/event-stream"
	}, isGoogleVertexCredentialsMarker(apiKey) ? await resolveGoogleVertexAuthorizedUserHeaders(fetchImpl) : { "x-goog-api-key": apiKey }, model.headers, optionHeaders) ?? {
		"Content-Type": "application/json",
		accept: "text/event-stream"
	};
}
function buildGoogleTransportRequestUrl(kind, model, options) {
	return kind === "google-vertex" ? buildGoogleVertexRequestUrl(model, options) : buildGoogleGenerativeAiRequestUrl(model);
}
function isOfficialGoogleGenerativeAiBaseUrl(baseUrl) {
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "generativelanguage.googleapis.com";
	} catch {
		return false;
	}
}
function resolveGoogleGemini3FirstResponseRetryMs(env = process.env) {
	const raw = env[GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV];
	if (raw === void 0 || raw.trim() === "") return GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
	return Math.floor(parsed);
}
function shouldRetryGoogleGemini3FirstResponse(params) {
	if (params.kind !== "google-generative-ai") return false;
	if (!isOfficialGoogleGenerativeAiBaseUrl(params.model.baseUrl)) return false;
	return isGoogleGemini3ProModel(params.model.id) || isGoogleGemini3FlashModel(params.model.id);
}
function resolveGoogleGemini3RetryThinkingLevel(modelId) {
	if (isGoogleGemini3ProModel(modelId)) return "LOW";
	if (isGoogleGemini3FlashModel(modelId)) return "MINIMAL";
}
function cloneGoogleGenerateContentRequest(params) {
	return JSON.parse(JSON.stringify(params));
}
function buildGoogleGemini3FirstResponseRetryParams(params) {
	const thinkingLevel = resolveGoogleGemini3RetryThinkingLevel(params.model.id);
	if (!thinkingLevel) return;
	const retryRequest = cloneGoogleGenerateContentRequest(params.request);
	const generationConfig = retryRequest.generationConfig && typeof retryRequest.generationConfig === "object" ? retryRequest.generationConfig : {};
	const thinkingConfig = generationConfig.thinkingConfig && typeof generationConfig.thinkingConfig === "object" ? { ...generationConfig.thinkingConfig } : {};
	delete thinkingConfig.thinkingBudget;
	delete thinkingConfig.includeThoughts;
	thinkingConfig.thinkingLevel = thinkingLevel;
	generationConfig.thinkingConfig = thinkingConfig;
	retryRequest.generationConfig = generationConfig;
	return retryRequest;
}
function createChildSignal(parent, timeoutMs) {
	const controller = new AbortController();
	let timedOut = false;
	let timeout;
	const abortFromParent = () => {
		controller.abort(parent?.reason);
	};
	if (parent) if (parent.aborted) abortFromParent();
	else parent.addEventListener("abort", abortFromParent, { once: true });
	if (timeoutMs > 0) {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort(/* @__PURE__ */ new Error("Google Gemini first response retry deadline reached"));
		}, timeoutMs);
		timeout.unref?.();
	}
	const clearDeadline = () => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = void 0;
		}
	};
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		clearDeadline,
		cleanup: () => {
			clearDeadline();
			parent?.removeEventListener("abort", abortFromParent);
		}
	};
}
function iteratorToAsyncGenerator(iterator, cleanup) {
	return (async function* () {
		try {
			for (;;) {
				const next = await iterator.next();
				if (next.done) return;
				yield next.value;
			}
		} finally {
			cleanup?.();
			await iterator.return?.();
		}
	})();
}
async function openGoogleSseAttempt(params) {
	const attemptSignal = params.firstResponseTimeoutMs > 0 ? createChildSignal(params.parentSignal, params.firstResponseTimeoutMs) : void 0;
	const signal = attemptSignal?.signal ?? params.parentSignal;
	try {
		const response = await params.guardedFetch(params.url, {
			method: "POST",
			headers: params.headers,
			body: JSON.stringify(params.request),
			signal
		});
		if (!response.ok) throw await createProviderHttpError(response, params.errorPrefix);
		const iterator = parseGoogleSseChunks(response, signal)[Symbol.asyncIterator]();
		const first = await iterator.next();
		attemptSignal?.clearDeadline();
		if (first.done) return {
			type: "ready",
			chunks: iteratorToAsyncGenerator(iterator, attemptSignal?.cleanup)
		};
		return {
			type: "ready",
			firstChunk: first.value,
			chunks: iteratorToAsyncGenerator(iterator, attemptSignal?.cleanup)
		};
	} catch (error) {
		attemptSignal?.cleanup();
		if (attemptSignal?.timedOut() && !params.parentSignal?.aborted) return { type: "timeout" };
		throw error;
	}
}
async function openGoogleSseChunks(params) {
	const errorPrefix = params.kind === "google-vertex" ? "Google Vertex AI API error" : "Google Generative AI API error";
	if (!shouldRetryGoogleGemini3FirstResponse({
		kind: params.kind,
		model: params.model
	})) {
		const response = await params.guardedFetch(params.url, {
			method: "POST",
			headers: params.headers,
			body: JSON.stringify(params.request),
			signal: params.options?.signal
		});
		if (!response.ok) throw await createProviderHttpError(response, errorPrefix);
		return {
			type: "ready",
			chunks: parseGoogleSseChunks(response, params.options?.signal)
		};
	}
	const retryMs = resolveGoogleGemini3FirstResponseRetryMs();
	const retryRequest = retryMs > 0 ? buildGoogleGemini3FirstResponseRetryParams({
		model: params.model,
		request: params.request
	}) : void 0;
	if (!retryRequest) {
		const response = await params.guardedFetch(params.url, {
			method: "POST",
			headers: params.headers,
			body: JSON.stringify(params.request),
			signal: params.options?.signal
		});
		if (!response.ok) throw await createProviderHttpError(response, errorPrefix);
		return {
			type: "ready",
			chunks: parseGoogleSseChunks(response, params.options?.signal)
		};
	}
	const firstAttempt = await openGoogleSseAttempt({
		guardedFetch: params.guardedFetch,
		url: params.url,
		headers: params.headers,
		request: params.request,
		parentSignal: params.options?.signal,
		firstResponseTimeoutMs: retryMs,
		errorPrefix
	});
	if (firstAttempt.type === "ready") return firstAttempt;
	const retryAttempt = await openGoogleSseAttempt({
		guardedFetch: params.guardedFetch,
		url: params.url,
		headers: params.headers,
		request: retryRequest,
		parentSignal: params.options?.signal,
		firstResponseTimeoutMs: 0,
		errorPrefix
	});
	if (retryAttempt.type === "timeout") throw new Error("Google Gemini first response retry timed out unexpectedly");
	return retryAttempt;
}
async function buildGoogleTransportHeaders(params) {
	return params.kind === "google-vertex" ? await buildGoogleVertexHeaders(params.model, params.apiKey, params.optionHeaders, params.fetchImpl) : buildGoogleHeaders(params.model, params.apiKey, params.optionHeaders);
}
async function* parseGoogleSseChunks(response, signal) {
	if (!response.body) throw new Error("No response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const abortHandler = () => {
		reader.cancel().catch(() => void 0);
	};
	signal?.addEventListener("abort", abortHandler);
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
				const data = rawEvent.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
				if (!data || data === "[DONE]") continue;
				try {
					yield JSON.parse(data);
				} catch {
					throw new Error("Google SSE stream returned malformed JSON");
				}
			}
		}
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}
function updateUsage(output, model, chunk) {
	const usage = chunk.usageMetadata;
	if (!usage) return;
	const promptTokens = usage.promptTokenCount || 0;
	const cacheRead = usage.cachedContentTokenCount || 0;
	output.usage = {
		input: Math.max(0, promptTokens - cacheRead),
		output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
		cacheRead,
		cacheWrite: 0,
		totalTokens: usage.totalTokenCount || 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
	calculateCost(model, output.usage);
}
function pushTextBlockEnd(stream, output, blockIndex) {
	const block = output.content[blockIndex];
	if (!block) return;
	if (block.type === "thinking") {
		stream.push({
			type: "thinking_end",
			contentIndex: blockIndex,
			content: block.thinking,
			partial: output
		});
		return;
	}
	if (block.type === "text") stream.push({
		type: "text_end",
		contentIndex: blockIndex,
		content: block.text,
		partial: output
	});
}
function createGoogleTransportStreamFn(kind) {
	return (rawModel, context, rawOptions) => {
		const model = rawModel;
		const options = rawOptions;
		const { eventStream, stream } = createWritableTransportEventStream();
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: kind,
				provider: model.provider,
				model: model.id,
				usage: createEmptyTransportUsage(),
				stopReason: "stop",
				timestamp: Date.now()
			};
			try {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? void 0;
				const guardedFetch = buildGuardedModelFetch(model);
				let params = buildGoogleGenerativeAiParams(model, context, options);
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				const sse = await openGoogleSseChunks({
					kind,
					model,
					options,
					guardedFetch,
					url: buildGoogleTransportRequestUrl(kind, model, options),
					headers: await buildGoogleTransportHeaders({
						kind,
						model,
						apiKey,
						optionHeaders: options?.headers,
						fetchImpl: options?.fetch
					}),
					request: params
				});
				stream.push({
					type: "start",
					partial: output
				});
				let currentBlockIndex = -1;
				const chunks = sse.firstChunk === void 0 ? sse.chunks : (async function* (firstChunk) {
					yield firstChunk;
					yield* sse.chunks;
				})(sse.firstChunk);
				for await (const chunk of chunks) {
					output.responseId ||= chunk.responseId;
					updateUsage(output, model, chunk);
					const candidate = chunk.candidates?.[0];
					if (candidate?.content?.parts) for (const part of candidate.content.parts) {
						const hasThoughtSignature = typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
						const hasText = typeof part.text === "string";
						if (hasText || hasThoughtSignature && !part.functionCall) {
							if (hasThoughtSignature && !hasText && part.thought !== true) {
								const latestBlock = output.content[output.content.length - 1];
								if (latestBlock?.type === "toolCall") {
									latestBlock.thoughtSignature = retainThoughtSignature(latestBlock.thoughtSignature, part.thoughtSignature);
									continue;
								}
							}
							const isThinking = part.thought === true || !hasText;
							const currentBlock = output.content[currentBlockIndex];
							if (currentBlockIndex < 0 || !currentBlock || isThinking && currentBlock.type !== "thinking" || !isThinking && currentBlock.type !== "text") {
								if (currentBlockIndex >= 0) pushTextBlockEnd(stream, output, currentBlockIndex);
								if (isThinking) {
									output.content.push({
										type: "thinking",
										thinking: ""
									});
									currentBlockIndex = output.content.length - 1;
									stream.push({
										type: "thinking_start",
										contentIndex: currentBlockIndex,
										partial: output
									});
								} else {
									output.content.push({
										type: "text",
										text: ""
									});
									currentBlockIndex = output.content.length - 1;
									stream.push({
										type: "text_start",
										contentIndex: currentBlockIndex,
										partial: output
									});
								}
							}
							const activeBlock = output.content[currentBlockIndex];
							if (activeBlock?.type === "thinking") {
								const delta = hasText ? part.text : "";
								activeBlock.thinking += delta;
								activeBlock.thinkingSignature = retainThoughtSignature(activeBlock.thinkingSignature, part.thoughtSignature);
								stream.push({
									type: "thinking_delta",
									contentIndex: currentBlockIndex,
									delta,
									partial: output
								});
							} else if (activeBlock?.type === "text") {
								activeBlock.text += part.text;
								activeBlock.textSignature = retainThoughtSignature(activeBlock.textSignature, part.thoughtSignature);
								stream.push({
									type: "text_delta",
									contentIndex: currentBlockIndex,
									delta: part.text,
									partial: output
								});
							}
						}
						if (part.functionCall) {
							if (currentBlockIndex >= 0) {
								pushTextBlockEnd(stream, output, currentBlockIndex);
								currentBlockIndex = -1;
							}
							const providedId = part.functionCall.id;
							const isDuplicate = output.content.some((block) => block.type === "toolCall" && block.id === providedId);
							const existingToolCall = typeof providedId === "string" ? output.content.find((block) => block.type === "toolCall" && block.id === providedId) : void 0;
							const toolCall = {
								type: "toolCall",
								id: providedId && !isDuplicate ? providedId : `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`,
								name: part.functionCall.name || "",
								arguments: part.functionCall.args ?? {},
								thoughtSignature: retainThoughtSignature(existingToolCall?.thoughtSignature, part.thoughtSignature)
							};
							output.content.push(toolCall);
							const blockIndex = output.content.length - 1;
							stream.push({
								type: "toolcall_start",
								contentIndex: blockIndex,
								partial: output
							});
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex,
								delta: JSON.stringify(toolCall.arguments),
								partial: output
							});
							stream.push({
								type: "toolcall_end",
								contentIndex: blockIndex,
								toolCall,
								partial: output
							});
						}
					}
					if (typeof candidate?.finishReason === "string") {
						output.stopReason = mapStopReasonString(candidate.finishReason);
						if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
					}
				}
				if (currentBlockIndex >= 0) pushTextBlockEnd(stream, output, currentBlockIndex);
				finalizeTransportStream({
					stream,
					output,
					signal: options?.signal
				});
			} catch (error) {
				failTransportStream({
					stream,
					output,
					signal: options?.signal,
					error
				});
			}
		})();
		return eventStream;
	};
}
function createGoogleGenerativeAiTransportStreamFn() {
	return createGoogleTransportStreamFn("google-generative-ai");
}
function createGoogleVertexTransportStreamFn() {
	return createGoogleTransportStreamFn("google-vertex");
}
//#endregion
export { createGoogleVertexTransportStreamFn as i, buildGoogleGenerativeAiParams as n, createGoogleGenerativeAiTransportStreamFn as r, buildGoogleGemini3FirstResponseRetryParams as t };
