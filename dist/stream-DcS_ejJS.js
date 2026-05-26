import { a as normalizeLowercaseStringOrEmpty, f as readStringValue } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import "./defaults-mDjiWzE5.js";
import { u as isNonSecretApiKeyMarker } from "./model-auth-markers-Cf78z2Zm.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { i as streamWithPayloadPatch, r as resolveMoonshotThinkingType, t as createMoonshotThinkingWrapper } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import "./provider-stream-shared-jI_a6bxx.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-model-shared-DtsPmvDx.js";
import "./provider-auth-BtRKd5us.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { n as OLLAMA_DEFAULT_BASE_URL } from "./defaults-Ct4-oW82.js";
import { n as buildOllamaBaseUrlSsrFPolicy } from "./provider-base-url-CrecHiog.js";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai";
//#region extensions/ollama/src/model-id.ts
const OLLAMA_PROVIDER_ID = "ollama";
function uniqueModelPrefixCandidates(providerId) {
	const candidates = [
		providerId,
		normalizeProviderId(providerId ?? ""),
		OLLAMA_PROVIDER_ID
	].map((candidate) => candidate?.trim()).filter((candidate) => Boolean(candidate));
	return [...new Set(candidates)];
}
function normalizeOllamaWireModelId(modelId, providerId) {
	const trimmed = modelId.trim();
	if (!trimmed) return trimmed;
	for (const candidate of uniqueModelPrefixCandidates(providerId)) {
		const prefix = `${candidate}/`;
		if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
	}
	return trimmed;
}
//#endregion
//#region extensions/ollama/src/ollama-json.ts
const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER);
function isAsciiDigit(ch) {
	return ch !== void 0 && ch >= "0" && ch <= "9";
}
function parseJsonNumberToken(input, start) {
	let idx = start;
	if (input[idx] === "-") idx += 1;
	if (idx >= input.length) return null;
	if (input[idx] === "0") idx += 1;
	else if (isAsciiDigit(input[idx]) && input[idx] !== "0") while (isAsciiDigit(input[idx])) idx += 1;
	else return null;
	let isInteger = true;
	if (input[idx] === ".") {
		isInteger = false;
		idx += 1;
		if (!isAsciiDigit(input[idx])) return null;
		while (isAsciiDigit(input[idx])) idx += 1;
	}
	if (input[idx] === "e" || input[idx] === "E") {
		isInteger = false;
		idx += 1;
		if (input[idx] === "+" || input[idx] === "-") idx += 1;
		if (!isAsciiDigit(input[idx])) return null;
		while (isAsciiDigit(input[idx])) idx += 1;
	}
	return {
		token: input.slice(start, idx),
		end: idx,
		isInteger
	};
}
function isUnsafeIntegerLiteral(token) {
	const digits = token[0] === "-" ? token.slice(1) : token;
	if (digits.length < MAX_SAFE_INTEGER_ABS_STR.length) return false;
	if (digits.length > MAX_SAFE_INTEGER_ABS_STR.length) return true;
	return digits > MAX_SAFE_INTEGER_ABS_STR;
}
function quoteUnsafeIntegerLiterals(input) {
	let out = "";
	let inString = false;
	let escaped = false;
	let idx = 0;
	while (idx < input.length) {
		const ch = input[idx] ?? "";
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			idx += 1;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			idx += 1;
			continue;
		}
		if (ch === "-" || isAsciiDigit(ch)) {
			const parsed = parseJsonNumberToken(input, idx);
			if (parsed) {
				if (parsed.isInteger && isUnsafeIntegerLiteral(parsed.token)) out += `"${parsed.token}"`;
				else out += parsed.token;
				idx = parsed.end;
				continue;
			}
		}
		out += ch;
		idx += 1;
	}
	return out;
}
function parseJsonPreservingUnsafeIntegers(input) {
	return JSON.parse(quoteUnsafeIntegerLiterals(input));
}
function parseJsonObjectPreservingUnsafeIntegers(value) {
	if (typeof value === "string") {
		try {
			const parsed = parseJsonPreservingUnsafeIntegers(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			return null;
		}
		return null;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) return value;
	return null;
}
//#endregion
//#region extensions/ollama/src/stream.ts
const log = createSubsystemLogger("ollama-stream");
const OLLAMA_NATIVE_BASE_URL = OLLAMA_DEFAULT_BASE_URL;
const GARBLED_VISIBLE_TEXT_MODEL_RE = /\b(?:glm|kimi)\b/i;
const GARBLED_VISIBLE_TEXT_MIN_CHARS = 80;
const GARBLED_VISIBLE_TEXT_SYMBOL_RE = /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]/gu;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/gu;
function countMatches(text, re) {
	re.lastIndex = 0;
	return Array.from(text.matchAll(re)).length;
}
function maxCharacterFrequency(text) {
	const counts = /* @__PURE__ */ new Map();
	let max = 0;
	for (const char of text) {
		const count = (counts.get(char) ?? 0) + 1;
		counts.set(char, count);
		max = Math.max(max, count);
	}
	return max;
}
function isKnownOllamaGarbledVisibleTextModel(modelId) {
	return GARBLED_VISIBLE_TEXT_MODEL_RE.test(modelId);
}
function isLikelyGarbledVisibleText(params) {
	if (!isKnownOllamaGarbledVisibleTextModel(params.modelId)) return false;
	const compact = params.text.replace(/\s+/g, "");
	if (compact.length < GARBLED_VISIBLE_TEXT_MIN_CHARS) return false;
	const letterOrDigitCount = countMatches(compact, LETTER_OR_DIGIT_RE);
	const symbolCount = countMatches(compact, GARBLED_VISIBLE_TEXT_SYMBOL_RE);
	const maxFrequency = maxCharacterFrequency(compact);
	const letterOrDigitRatio = letterOrDigitCount / compact.length;
	const symbolRatio = symbolCount / compact.length;
	const dominantCharacterRatio = maxFrequency / compact.length;
	return letterOrDigitRatio < .08 && symbolRatio > .6 && (dominantCharacterRatio > .22 || /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]{12,}/u.test(compact));
}
function resolveOllamaBaseUrlForRun(params) {
	const providerBaseUrl = params.providerBaseUrl?.trim();
	if (providerBaseUrl) return providerBaseUrl;
	const modelBaseUrl = params.modelBaseUrl?.trim();
	if (modelBaseUrl) return modelBaseUrl;
	return OLLAMA_NATIVE_BASE_URL;
}
function resolveConfiguredOllamaProviderConfig(params) {
	const providerId = params.providerId?.trim();
	if (!providerId) return;
	const providers = params.config?.models?.providers;
	if (!providers) return;
	const direct = providers[providerId];
	if (direct) return direct;
	const normalized = normalizeProviderId(providerId);
	for (const [candidateId, candidate] of Object.entries(providers)) if (normalizeProviderId(candidateId) === normalized) return candidate;
}
function isOllamaCompatProvider(model) {
	const providerId = normalizeProviderId(model.provider ?? "");
	if (providerId === "ollama") return true;
	if (!model.baseUrl) return false;
	try {
		const parsed = new URL(model.baseUrl);
		const hostname = normalizeLowercaseStringOrEmpty(parsed.hostname);
		if ((hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") && parsed.port === "11434") return true;
		const providerHintsOllama = providerId.includes("ollama");
		const isOllamaPort = parsed.port === "11434";
		const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
		return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
	} catch {
		return false;
	}
}
function resolveOllamaCompatNumCtxEnabled(params) {
	return resolveConfiguredOllamaProviderConfig(params)?.injectNumCtxForOpenAICompat ?? true;
}
function shouldInjectOllamaCompatNumCtx(params) {
	if (params.model.api !== "openai-completions") return false;
	if (!isOllamaCompatProvider(params.model)) return false;
	return resolveOllamaCompatNumCtxEnabled({
		config: params.config,
		providerId: params.providerId
	});
}
function wrapOllamaCompatNumCtx(baseFn, numCtx) {
	const streamFn = baseFn ?? streamSimple;
	return (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payloadRecord) => {
		if (!payloadRecord.options || typeof payloadRecord.options !== "object") payloadRecord.options = {};
		payloadRecord.options.num_ctx = numCtx;
		normalizeOllamaCompatMessageToolArgs(payloadRecord);
	});
}
const OLLAMA_OPTION_PARAM_KEYS = new Set([
	"num_keep",
	"seed",
	"num_predict",
	"top_k",
	"top_p",
	"min_p",
	"typical_p",
	"repeat_last_n",
	"temperature",
	"repeat_penalty",
	"presence_penalty",
	"frequency_penalty",
	"stop",
	"num_ctx",
	"num_batch",
	"num_gpu",
	"main_gpu",
	"use_mmap",
	"num_thread"
]);
const OLLAMA_TOP_LEVEL_PARAM_KEYS = new Set([
	"format",
	"keep_alive",
	"truncate",
	"shift"
]);
function createOllamaThinkingWrapper(baseFn, think) {
	const streamFn = baseFn ?? streamSimple;
	return (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payloadRecord) => {
		payloadRecord.think = think;
	});
}
function resolveOllamaThinkValue(thinkingLevel) {
	if (thinkingLevel === "off") return false;
	if (thinkingLevel === "low" || thinkingLevel === "medium" || thinkingLevel === "high") return thinkingLevel;
	if (thinkingLevel === "minimal") return "low";
	if (thinkingLevel === "xhigh" || thinkingLevel === "adaptive" || thinkingLevel === "max") return "high";
}
function resolveOllamaThinkParamValue(params) {
	const raw = params?.think ?? params?.thinking;
	if (typeof raw === "boolean") return raw;
	if (raw === "off") return false;
	if (raw === "low" || raw === "medium" || raw === "high") return raw;
	if (raw === "minimal") return "low";
	if (raw === "xhigh" || raw === "adaptive" || raw === "max") return "high";
}
function shouldForwardNativeOllamaThink(model, think) {
	return think === false || model?.reasoning !== false;
}
function resolveOllamaConfiguredNumCtx(model) {
	const raw = model.params?.num_ctx;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return;
	return Math.floor(raw);
}
function resolveOllamaNumCtx(model) {
	return resolveOllamaConfiguredNumCtx(model) ?? Math.max(1, Math.floor(model.contextWindow ?? model.maxTokens ?? 2e5));
}
/**
* Resolves num_ctx for native /api/chat requests:
*  1. explicit `params.num_ctx` set on the model wins,
*  2. otherwise return undefined so Ollama's model, OLLAMA_CONTEXT_LENGTH,
*     VRAM, or Modelfile policy decides.
*
* This intentionally differs from `resolveOllamaNumCtx` by not falling back
* to `DEFAULT_CONTEXT_TOKENS`: that constant is a sane wrapper-side guess for
* the OpenAI-compat path, but native `/api/chat` should not force the full
* advertised catalog context for local models unless the operator opted in.
*/
function resolveOllamaNativeNumCtx(model) {
	return resolveOllamaConfiguredNumCtx(model);
}
function resolveOllamaModelOptions(model) {
	const options = {};
	const params = model.params;
	if (params && typeof params === "object" && !Array.isArray(params)) for (const [key, value] of Object.entries(params)) {
		if (key === "num_ctx") continue;
		if (value !== void 0 && OLLAMA_OPTION_PARAM_KEYS.has(key)) options[key] = value;
	}
	const numCtx = resolveOllamaNativeNumCtx(model);
	if (numCtx !== void 0) options.num_ctx = numCtx;
	return options;
}
function resolveOllamaTopLevelParams(model) {
	const requestParams = {};
	const params = model.params;
	if (params && typeof params === "object" && !Array.isArray(params)) {
		for (const [key, value] of Object.entries(params)) if (value !== void 0 && OLLAMA_TOP_LEVEL_PARAM_KEYS.has(key)) requestParams[key] = value;
	}
	const think = resolveOllamaThinkParamValue(params);
	if (think !== void 0 && shouldForwardNativeOllamaThink(model, think)) requestParams.think = think;
	return Object.keys(requestParams).length > 0 ? requestParams : void 0;
}
function isOllamaCloudKimiModelRef(modelId) {
	const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
	return normalizedModelId.startsWith("kimi-k") && normalizedModelId.includes(":cloud");
}
function createConfiguredOllamaCompatStreamWrapper(ctx) {
	let streamFn = ctx.streamFn;
	const model = ctx.model;
	let injectNumCtx = false;
	const isNativeOllamaTransport = model?.api === "ollama";
	if (model) {
		const providerId = typeof model.provider === "string" && model.provider.trim().length > 0 ? model.provider : ctx.provider;
		if (shouldInjectOllamaCompatNumCtx({
			model,
			config: ctx.config,
			providerId
		})) injectNumCtx = true;
	}
	if (injectNumCtx && model) streamFn = wrapOllamaCompatNumCtx(streamFn, resolveOllamaNumCtx(model));
	const configuredThinkValue = model ? resolveOllamaThinkParamValue(model.params) : void 0;
	const runtimeThinkValue = isNativeOllamaTransport ? resolveOllamaThinkValue(ctx.thinkingLevel) : void 0;
	const ollamaThinkValue = runtimeThinkValue === false && configuredThinkValue !== void 0 ? void 0 : runtimeThinkValue;
	if (ollamaThinkValue !== void 0 && shouldForwardNativeOllamaThink(model, ollamaThinkValue)) streamFn = createOllamaThinkingWrapper(streamFn, ollamaThinkValue);
	if (normalizeProviderId(ctx.provider) === "ollama" && isOllamaCloudKimiModelRef(ctx.modelId)) {
		const thinkingType = resolveMoonshotThinkingType({
			configuredThinking: ctx.extraParams?.thinking,
			thinkingLevel: ctx.thinkingLevel
		});
		streamFn = createMoonshotThinkingWrapper(streamFn, thinkingType);
	}
	return streamFn;
}
/** @deprecated Use createConfiguredOllamaCompatStreamWrapper. */
const createConfiguredOllamaCompatNumCtxWrapper = createConfiguredOllamaCompatStreamWrapper;
function buildOllamaChatRequest(params) {
	return {
		model: normalizeOllamaWireModelId(params.modelId, params.providerId),
		messages: params.messages,
		stream: params.stream ?? true,
		...params.tools && params.tools.length > 0 ? { tools: params.tools } : {},
		...params.options ? { options: params.options } : {},
		...params.requestParams
	};
}
const CHARS_PER_TOKEN_ESTIMATE = 4;
function buildUsageWithNoCost(params) {
	const input = params.input ?? 0;
	const output = params.output ?? 0;
	return {
		input,
		output,
		cacheRead: params.cacheRead ?? 0,
		cacheWrite: params.cacheWrite ?? 0,
		totalTokens: params.totalTokens ?? input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function buildStreamAssistantMessage(params) {
	return {
		role: "assistant",
		content: params.content,
		stopReason: params.stopReason,
		api: params.model.api,
		provider: params.model.provider,
		model: params.model.id,
		usage: params.usage,
		timestamp: params.timestamp ?? Date.now()
	};
}
function buildStreamErrorAssistantMessage(params) {
	return {
		...buildStreamAssistantMessage({
			model: params.model,
			content: [],
			stopReason: "error",
			usage: buildUsageWithNoCost({}),
			timestamp: params.timestamp
		}),
		stopReason: "error",
		errorMessage: params.errorMessage
	};
}
function safeJsonLength(value) {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? serialized.length : 0;
	} catch {
		return 0;
	}
}
function estimateTokensFromChars(chars) {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return Math.max(1, Math.round(chars / CHARS_PER_TOKEN_ESTIMATE));
}
function estimateOllamaPromptTokens(params) {
	let chars = 0;
	for (const message of params.messages) {
		chars += message.content.length;
		chars += safeJsonLength(message.images);
		chars += safeJsonLength(message.tool_calls);
		chars += message.tool_name?.length ?? 0;
	}
	chars += safeJsonLength(params.tools);
	return estimateTokensFromChars(chars);
}
function estimateOllamaCompletionTokens(response) {
	return estimateTokensFromChars(response.message.content.length + (response.message.thinking?.length ?? 0) + (response.message.reasoning?.length ?? 0) + safeJsonLength(response.message.tool_calls));
}
function resolveUsageCount(value, fallback) {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
	return 0;
}
function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}
function extractOllamaImages(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((part) => part.type === "image").map((part) => part.data);
}
function ensureArgsObject(value) {
	return parseJsonObjectPreservingUnsafeIntegers(value) ?? {};
}
function normalizeOllamaToolCallArguments(value) {
	return ensureArgsObject(value);
}
function normalizeOllamaCompatMessageToolArgs(payloadRecord) {
	const messages = payloadRecord.messages;
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const messageRecord = message;
		const functionCall = messageRecord.function_call;
		if (functionCall && typeof functionCall === "object" && !Array.isArray(functionCall)) {
			const functionCallRecord = functionCall;
			if (Object.hasOwn(functionCallRecord, "arguments")) functionCallRecord.arguments = ensureArgsObject(functionCallRecord.arguments);
		}
		const toolCalls = messageRecord.tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		for (const toolCall of toolCalls) {
			if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) continue;
			const functionSpec = toolCall.function;
			if (!functionSpec || typeof functionSpec !== "object" || Array.isArray(functionSpec)) continue;
			const functionRecord = functionSpec;
			if (Object.hasOwn(functionRecord, "arguments")) functionRecord.arguments = ensureArgsObject(functionRecord.arguments);
		}
	}
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function inferOllamaSchemaType(schema) {
	if (schema.properties && isRecord(schema.properties)) return "object";
	if (schema.items) return "array";
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const values = schema.enum.filter((value) => value !== null);
		if (values.length > 0 && values.every((value) => typeof value === "string")) return "string";
		if (values.length > 0 && values.every((value) => typeof value === "number")) return "number";
		if (values.length > 0 && values.every((value) => typeof value === "boolean")) return "boolean";
	}
	for (const unionKey of ["anyOf", "oneOf"]) {
		const variants = schema[unionKey];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (!isRecord(variant)) continue;
			const variantType = variant.type;
			if (typeof variantType === "string" && variantType !== "null") return variantType;
			if (Array.isArray(variantType)) {
				const firstType = variantType.find((entry) => typeof entry === "string" && entry !== "null");
				if (firstType) return firstType;
			}
			const inferred = inferOllamaSchemaType(variant);
			if (inferred) return inferred;
		}
	}
}
function normalizeOllamaToolSchema(schema, isRoot = false) {
	if (!isRecord(schema)) return {
		type: "object",
		properties: {}
	};
	const normalized = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && isRecord(value)) {
			normalized.properties = Object.fromEntries(Object.entries(value).map(([propertyName, propertySchema]) => [propertyName, normalizeOllamaToolSchema(propertySchema)]));
			continue;
		}
		if (key === "items") {
			normalized.items = Array.isArray(value) ? value.map((entry) => normalizeOllamaToolSchema(entry)) : normalizeOllamaToolSchema(value);
			continue;
		}
		if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
			normalized[key] = value.map((entry) => normalizeOllamaToolSchema(entry));
			continue;
		}
		normalized[key] = value;
	}
	const schemaType = normalized.type;
	if (typeof schemaType !== "string" && (!Array.isArray(schemaType) || !schemaType.some((entry) => typeof entry === "string" && entry !== "null"))) normalized.type = inferOllamaSchemaType(normalized) ?? (isRoot ? "object" : "string");
	if (normalized.type === "object" && !isRecord(normalized.properties)) normalized.properties = {};
	return normalized;
}
function readOllamaToolCallId(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function extractToolCalls(content, options = {}) {
	if (!Array.isArray(content)) return [];
	const parts = content;
	const result = [];
	for (const part of parts) if (part.type === "toolCall") {
		const id = readOllamaToolCallId(part.id);
		result.push({
			...id ? { id } : {},
			function: {
				name: normalizeOllamaToolCallName(part.name, options),
				arguments: ensureArgsObject(part.arguments)
			}
		});
	} else if (part.type === "tool_use") {
		const id = readOllamaToolCallId(part.id);
		result.push({
			...id ? { id } : {},
			function: {
				name: normalizeOllamaToolCallName(part.name, options),
				arguments: ensureArgsObject(part.input)
			}
		});
	}
	return result;
}
function buildOllamaToolNameSet(tools) {
	if (!tools || !Array.isArray(tools)) return;
	const names = /* @__PURE__ */ new Set();
	for (const tool of tools) if (typeof tool.name === "string" && tool.name.trim()) names.add(tool.name.trim());
	return names.size > 0 ? names : void 0;
}
function normalizeOllamaToolCallName(rawName, options = {}) {
	const trimmed = rawName.trim();
	if (!trimmed) return trimmed;
	const availableToolNames = options.availableToolNames;
	if (availableToolNames?.has(trimmed)) return trimmed;
	const strippedAnySeparator = trimmed.replace(/^(?:functions?|tools?)[./_-]+/iu, "").trim();
	if (availableToolNames && strippedAnySeparator !== trimmed && availableToolNames.has(strippedAnySeparator)) return strippedAnySeparator;
	if (availableToolNames) return trimmed;
	return trimmed.replace(/^(?:functions?|tools?)[./]+/iu, "").trim();
}
function convertToOllamaMessages(messages, system, options = {}) {
	const result = [];
	if (system) result.push({
		role: "system",
		content: system
	});
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = extractTextContent(msg.content);
			const images = extractOllamaImages(msg.content);
			result.push({
				role: "user",
				content: text,
				...images.length > 0 ? { images } : {}
			});
			continue;
		}
		if (msg.role === "assistant") {
			const text = extractTextContent(msg.content);
			const toolCalls = extractToolCalls(msg.content, options);
			result.push({
				role: "assistant",
				content: text,
				...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
			});
			continue;
		}
		if (msg.role === "tool" || msg.role === "toolResult") {
			const text = extractTextContent(msg.content);
			const toolName = typeof msg.toolName === "string" ? msg.toolName : void 0;
			result.push({
				role: "tool",
				content: text,
				...toolName ? { tool_name: toolName } : {}
			});
		}
	}
	return result;
}
function extractOllamaTools(tools) {
	if (!tools || !Array.isArray(tools)) return [];
	const result = [];
	for (const tool of tools) {
		if (typeof tool.name !== "string" || !tool.name) continue;
		result.push({
			type: "function",
			function: {
				name: tool.name,
				description: typeof tool.description === "string" ? tool.description : "",
				parameters: normalizeOllamaToolSchema(tool.parameters, true)
			}
		});
	}
	return result;
}
function buildAssistantMessage(response, modelInfo, usageFallback, options = {}) {
	const content = [];
	const thinking = response.message.thinking ?? response.message.reasoning ?? "";
	if (thinking) content.push({
		type: "thinking",
		thinking
	});
	const text = response.message.content || "";
	if (text) content.push({
		type: "text",
		text
	});
	const toolCalls = response.message.tool_calls;
	if (toolCalls && toolCalls.length > 0) for (const toolCall of toolCalls) content.push({
		type: "toolCall",
		id: readOllamaToolCallId(toolCall.id) ?? `ollama_call_${randomUUID()}`,
		name: normalizeOllamaToolCallName(toolCall.function.name, options),
		arguments: normalizeOllamaToolCallArguments(toolCall.function.arguments)
	});
	return buildStreamAssistantMessage({
		model: modelInfo,
		content,
		stopReason: toolCalls && toolCalls.length > 0 ? "toolUse" : "stop",
		usage: buildUsageWithNoCost({
			input: resolveUsageCount(response.prompt_eval_count, usageFallback?.input),
			output: resolveUsageCount(response.eval_count, usageFallback?.output)
		})
	});
}
async function* parseNdjsonStream(reader) {
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				yield parseJsonPreservingUnsafeIntegers(trimmed);
			} catch {
				log.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, 120)}`);
			}
		}
	}
	if (buffer.trim()) try {
		yield parseJsonPreservingUnsafeIntegers(buffer.trim());
	} catch {
		log.warn(`Skipping malformed trailing data: ${buffer.trim().slice(0, 120)}`);
	}
}
function resolveOllamaChatUrl(baseUrl) {
	return `${baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "") || OLLAMA_NATIVE_BASE_URL}/api/chat`;
}
function resolveOllamaModelHeaders(model) {
	if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) return;
	return model.headers;
}
function resolveOllamaRequestTimeoutMs(model, options) {
	const raw = options?.requestTimeoutMs ?? options?.timeoutMs ?? model.requestTimeoutMs;
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : void 0;
}
function createOllamaStreamFn(baseUrl, defaultHeaders) {
	const chatUrl = resolveOllamaChatUrl(baseUrl);
	const ssrfPolicy = buildOllamaBaseUrlSsrFPolicy(chatUrl);
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const run = async () => {
			try {
				const availableToolNames = buildOllamaToolNameSet(context.tools);
				const toolCallNameOptions = availableToolNames ? { availableToolNames } : {};
				const ollamaMessages = convertToOllamaMessages(context.messages ?? [], context.systemPrompt, toolCallNameOptions);
				const ollamaTools = extractOllamaTools(context.tools);
				const ollamaOptions = resolveOllamaModelOptions(model);
				if (typeof options?.temperature === "number") ollamaOptions.temperature = options.temperature;
				if (typeof options?.maxTokens === "number") ollamaOptions.num_predict = options.maxTokens;
				const body = buildOllamaChatRequest({
					modelId: model.id,
					providerId: model.provider,
					messages: ollamaMessages,
					stream: true,
					tools: ollamaTools,
					options: ollamaOptions,
					requestParams: resolveOllamaTopLevelParams(model)
				});
				options?.onPayload?.(body, model);
				const headers = {
					"Content-Type": "application/json",
					...defaultHeaders,
					...options?.headers
				};
				if (options?.apiKey && (!headers.Authorization || !isNonSecretApiKeyMarker(options.apiKey))) headers.Authorization = `Bearer ${options.apiKey}`;
				const { response, release } = await fetchWithSsrFGuard({
					url: chatUrl,
					init: {
						method: "POST",
						headers,
						body: JSON.stringify(body)
					},
					policy: ssrfPolicy,
					...options?.signal ? { signal: options.signal } : {},
					timeoutMs: resolveOllamaRequestTimeoutMs(model, options),
					auditContext: "ollama-stream.chat"
				});
				try {
					if (!response.ok) {
						const errorText = await response.text().catch(() => "unknown error");
						throw new Error(`${response.status} ${errorText}`);
					}
					if (!response.body) throw new Error("Ollama API returned empty response body");
					const reader = response.body.getReader();
					let accumulatedContent = "";
					let accumulatedThinking = "";
					const accumulatedToolCalls = [];
					let finalResponse;
					const modelInfo = {
						api: model.api,
						provider: model.provider,
						id: model.id
					};
					let streamStarted = false;
					let thinkingStarted = false;
					let thinkingEnded = false;
					let textBlockStarted = false;
					let textBlockClosed = false;
					const textContentIndex = () => thinkingStarted ? 1 : 0;
					const buildCurrentContent = () => {
						const parts = [];
						if (accumulatedThinking) parts.push({
							type: "thinking",
							thinking: accumulatedThinking
						});
						if (accumulatedContent) parts.push({
							type: "text",
							text: accumulatedContent
						});
						return parts;
					};
					const closeThinkingBlock = () => {
						if (!thinkingStarted || thinkingEnded) return;
						thinkingEnded = true;
						const partial = buildStreamAssistantMessage({
							model: modelInfo,
							content: buildCurrentContent(),
							stopReason: "stop",
							usage: buildUsageWithNoCost({})
						});
						stream.push({
							type: "thinking_end",
							contentIndex: 0,
							content: accumulatedThinking,
							partial
						});
					};
					const closeTextBlock = () => {
						if (!textBlockStarted || textBlockClosed) return;
						textBlockClosed = true;
						const partial = buildStreamAssistantMessage({
							model: modelInfo,
							content: buildCurrentContent(),
							stopReason: "stop",
							usage: buildUsageWithNoCost({})
						});
						stream.push({
							type: "text_end",
							contentIndex: textContentIndex(),
							content: accumulatedContent,
							partial
						});
					};
					for await (const chunk of parseNdjsonStream(reader)) {
						const thinkingDelta = chunk.message?.thinking ?? chunk.message?.reasoning;
						if (thinkingDelta) {
							if (!streamStarted) {
								streamStarted = true;
								const emptyPartial = buildStreamAssistantMessage({
									model: modelInfo,
									content: [],
									stopReason: "stop",
									usage: buildUsageWithNoCost({})
								});
								stream.push({
									type: "start",
									partial: emptyPartial
								});
							}
							if (!thinkingStarted) {
								thinkingStarted = true;
								const partial = buildStreamAssistantMessage({
									model: modelInfo,
									content: buildCurrentContent(),
									stopReason: "stop",
									usage: buildUsageWithNoCost({})
								});
								stream.push({
									type: "thinking_start",
									contentIndex: 0,
									partial
								});
							}
							accumulatedThinking += thinkingDelta;
							const partial = buildStreamAssistantMessage({
								model: modelInfo,
								content: buildCurrentContent(),
								stopReason: "stop",
								usage: buildUsageWithNoCost({})
							});
							stream.push({
								type: "thinking_delta",
								contentIndex: 0,
								delta: thinkingDelta,
								partial
							});
						}
						if (chunk.message?.content) {
							const delta = chunk.message.content;
							if (thinkingStarted && !thinkingEnded) closeThinkingBlock();
							if (!streamStarted) {
								streamStarted = true;
								const emptyPartial = buildStreamAssistantMessage({
									model: modelInfo,
									content: [],
									stopReason: "stop",
									usage: buildUsageWithNoCost({})
								});
								stream.push({
									type: "start",
									partial: emptyPartial
								});
							}
							if (!textBlockStarted) {
								textBlockStarted = true;
								const partial = buildStreamAssistantMessage({
									model: modelInfo,
									content: buildCurrentContent(),
									stopReason: "stop",
									usage: buildUsageWithNoCost({})
								});
								stream.push({
									type: "text_start",
									contentIndex: textContentIndex(),
									partial
								});
							}
							accumulatedContent += delta;
							const partial = buildStreamAssistantMessage({
								model: modelInfo,
								content: buildCurrentContent(),
								stopReason: "stop",
								usage: buildUsageWithNoCost({})
							});
							stream.push({
								type: "text_delta",
								contentIndex: textContentIndex(),
								delta,
								partial
							});
						}
						if (chunk.message?.tool_calls) {
							closeThinkingBlock();
							closeTextBlock();
							accumulatedToolCalls.push(...chunk.message.tool_calls);
						}
						if (chunk.done) {
							finalResponse = chunk;
							break;
						}
					}
					if (!finalResponse) throw new Error("Ollama API stream ended without a final response");
					if (isLikelyGarbledVisibleText({
						text: accumulatedContent,
						modelId: model.id
					})) throw new Error(`Ollama returned non-linguistic garbled visible text for ${model.id}; retry or switch models`);
					finalResponse.message.content = accumulatedContent;
					if (accumulatedThinking) finalResponse.message.thinking = accumulatedThinking;
					if (accumulatedToolCalls.length > 0) finalResponse.message.tool_calls = accumulatedToolCalls;
					const usageFallback = {
						input: estimateOllamaPromptTokens({
							messages: ollamaMessages,
							tools: ollamaTools
						}),
						output: estimateOllamaCompletionTokens(finalResponse)
					};
					const assistantMessage = buildAssistantMessage(finalResponse, modelInfo, usageFallback, toolCallNameOptions);
					closeThinkingBlock();
					closeTextBlock();
					stream.push({
						type: "done",
						reason: assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop",
						message: assistantMessage
					});
				} finally {
					await release();
				}
			} catch (err) {
				stream.push({
					type: "error",
					reason: "error",
					error: buildStreamErrorAssistantMessage({
						model,
						errorMessage: formatErrorMessage(err)
					})
				});
			} finally {
				stream.end();
			}
		};
		queueMicrotask(() => void run());
		return stream;
	};
}
function createConfiguredOllamaStreamFn(params) {
	return createOllamaStreamFn(resolveOllamaBaseUrlForRun({
		modelBaseUrl: readStringValue(params.model.baseUrl),
		providerBaseUrl: params.providerBaseUrl
	}), resolveOllamaModelHeaders(params.model));
}
//#endregion
export { createConfiguredOllamaCompatNumCtxWrapper as a, createOllamaStreamFn as c, resolveConfiguredOllamaProviderConfig as d, resolveOllamaBaseUrlForRun as f, normalizeOllamaWireModelId as g, wrapOllamaCompatNumCtx as h, convertToOllamaMessages as i, isOllamaCompatProvider as l, shouldInjectOllamaCompatNumCtx as m, buildAssistantMessage as n, createConfiguredOllamaCompatStreamWrapper as o, resolveOllamaCompatNumCtxEnabled as p, buildOllamaChatRequest as r, createConfiguredOllamaStreamFn as s, OLLAMA_NATIVE_BASE_URL as t, parseNdjsonStream as u };
