import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { i as emitAgentEvent, l as onAgentEvent } from "./agent-events-BuYtWSh4.js";
import { i as hasNonzeroUsage, o as normalizeUsage, s as toOpenAiChatCompletionsUsage } from "./usage-DKNTRfvn.js";
import "./selection-hR-AeOeU.js";
import { n as estimateBase64DecodedBytes } from "./base64-D03BM6T6.js";
import { i as isClientToolNameConflictError } from "./tool-split-Cs6WJ2Aa.js";
import { a as extractImageContentFromSource, n as DEFAULT_INPUT_IMAGE_MIMES, o as normalizeMimeList, r as DEFAULT_INPUT_TIMEOUT_MS, t as DEFAULT_INPUT_IMAGE_MAX_BYTES } from "./input-files-uQel9TbR.js";
import { n as agentCommandFromIngress } from "./agent-command-QBBzz2Au.js";
import { t as createDefaultDeps } from "./deps-C1bdn-NA.js";
import "./agent-DBVvbEwY.js";
import { a as sendJson, d as writeDone, l as setSseHeaders, u as watchClientDisconnect } from "./http-common-D6Lgf8u5.js";
import { l as resolveOpenAiCompatibleHttpOperatorScopes } from "./http-auth-utils-Bn7sdLLK.js";
import { a as resolveGatewayRequestContext, o as resolveOpenAiCompatModelOverride } from "./http-utils-GEkok2ix.js";
import { t as handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers-B1Tw6PpU.js";
import { a as resolveAssistantStreamDeltaText, i as buildAgentMessageFromConversationEntries, n as validateOpenAiSamplingParams, r as normalizeInputHostnameAllowlist, t as resolveOpenAiCompatError } from "./openai-compat-errors-BU9I_wNs.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/openai-http.ts
const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS = {
	allowUrl: false,
	allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
	maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
	maxRedirects: 3,
	timeoutMs: DEFAULT_INPUT_TIMEOUT_MS
};
function resolveOpenAiChatCompletionsLimits(config) {
	const imageConfig = config?.images;
	return {
		maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
		maxImageParts: typeof config?.maxImageParts === "number" ? Math.max(0, Math.floor(config.maxImageParts)) : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
		maxTotalImageBytes: typeof config?.maxTotalImageBytes === "number" ? Math.max(1, Math.floor(config.maxTotalImageBytes)) : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
		images: {
			allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
			urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
			allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
			maxBytes: imageConfig?.maxBytes ?? 10485760,
			maxRedirects: imageConfig?.maxRedirects ?? 3,
			timeoutMs: imageConfig?.timeoutMs ?? 1e4
		}
	};
}
function writeSse(res, data) {
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function buildAgentCommandInput(params) {
	return {
		message: params.prompt.message,
		extraSystemPrompt: params.prompt.extraSystemPrompt,
		images: params.prompt.images,
		clientTools: params.clientTools,
		model: params.modelOverride,
		sessionKey: params.sessionKey,
		runId: params.runId,
		deliver: false,
		messageChannel: params.messageChannel,
		bestEffortDeliver: false,
		allowModelOverride: true,
		abortSignal: params.abortSignal,
		streamParams: params.streamParams
	};
}
function extractClientToolsFromChatRequest(tools) {
	if (tools == null) return [];
	if (!Array.isArray(tools)) throw new Error("tools must be an array");
	const clientTools = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw new Error("each tool must be an object");
		if (tool.type !== "function") throw new Error("only function tools are supported");
		const functionValue = tool.function;
		if (!functionValue || typeof functionValue !== "object" || Array.isArray(functionValue)) throw new Error("tool.function is required");
		const rawName = functionValue.name;
		const name = typeof rawName === "string" ? rawName.trim() : "";
		if (!name) throw new Error("tool.function.name is required");
		const description = functionValue.description;
		const parameters = functionValue.parameters;
		const strict = functionValue.strict;
		clientTools.push({
			type: "function",
			function: {
				name,
				...typeof description === "string" ? { description } : {},
				...parameters && typeof parameters === "object" && !Array.isArray(parameters) ? { parameters } : {},
				...typeof strict === "boolean" ? { strict } : {}
			}
		});
	}
	return clientTools;
}
function applyChatToolChoice(params) {
	const { tools, toolChoice } = params;
	if (toolChoice == null || toolChoice === "auto") return { tools };
	if (toolChoice === "none") return { tools: [] };
	if (toolChoice === "required") throw new Error("tool_choice=required is not supported");
	if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) throw new Error("tool_choice must be a string or object");
	const choiceType = toolChoice.type;
	if (typeof choiceType !== "string") throw new Error("unsupported tool_choice type");
	throw new Error(`tool_choice ${choiceType} is not supported`);
}
function writeAssistantRoleChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [{
			index: 0,
			delta: { role: "assistant" },
			finish_reason: null
		}]
	});
}
function writeAssistantContentChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [{
			index: 0,
			delta: { content: params.content },
			finish_reason: params.finishReason
		}]
	});
}
function writeAssistantFinishChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [{
			index: 0,
			delta: {},
			finish_reason: params.finishReason
		}]
	});
}
function splitArgumentsForStreaming(argumentsValue) {
	if (!argumentsValue) return [""];
	const chunkSize = 256;
	const chunks = [];
	for (let i = 0; i < argumentsValue.length; i += chunkSize) chunks.push(argumentsValue.slice(i, i + chunkSize));
	return chunks.length > 0 ? chunks : [""];
}
function writeAssistantToolCallsIncrementalChunks(res, params) {
	for (const [index, call] of params.toolCalls.entries()) {
		writeSse(res, {
			id: params.runId,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1e3),
			model: params.model,
			choices: [{
				index: 0,
				delta: { tool_calls: [{
					index,
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments: ""
					}
				}] },
				finish_reason: null
			}]
		});
		for (const argsDelta of splitArgumentsForStreaming(call.arguments)) writeSse(res, {
			id: params.runId,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1e3),
			model: params.model,
			choices: [{
				index: 0,
				delta: { tool_calls: [{
					index,
					function: { arguments: argsDelta }
				}] },
				finish_reason: null
			}]
		});
	}
}
function writeUsageChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [],
		usage: params.usage
	});
}
function asMessages(val) {
	return Array.isArray(val) ? val : [];
}
function extractTextContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const type = part.type;
		const text = part.text;
		const inputText = part.input_text;
		if (type === "text" && typeof text === "string") return text;
		if (type === "input_text" && typeof text === "string") return text;
		if (typeof inputText === "string") return inputText;
		return "";
	}).filter(Boolean).join("\n");
	return "";
}
function stringifyToolCallArguments(value) {
	if (typeof value === "string") return value;
	if (value == null) return "";
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? serialized : "";
	} catch {
		return "";
	}
}
function extractAssistantToolCalls(value) {
	if (!Array.isArray(value)) return [];
	const calls = [];
	for (const rawCall of value) {
		if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) continue;
		const id = normalizeOptionalString(rawCall.id) ?? "";
		const functionValue = rawCall.function;
		if (!functionValue || typeof functionValue !== "object" || Array.isArray(functionValue)) continue;
		const name = normalizeOptionalString(functionValue.name) ?? "";
		if (!id || !name) continue;
		const argumentsValue = stringifyToolCallArguments(functionValue.arguments);
		calls.push({
			id,
			name,
			arguments: argumentsValue
		});
	}
	return calls;
}
function renderAssistantToolCalls(calls) {
	return calls.map((call) => `tool_call id=${call.id} name=${call.name} arguments=${call.arguments}`).join("\n");
}
function resolveImageUrlPart(part) {
	if (!part || typeof part !== "object") return;
	const imageUrl = part.image_url;
	if (typeof imageUrl === "string") {
		const trimmed = imageUrl.trim();
		return trimmed.length > 0 ? trimmed : void 0;
	}
	if (!imageUrl || typeof imageUrl !== "object") return;
	const rawUrl = imageUrl.url;
	if (typeof rawUrl !== "string") return;
	const trimmed = rawUrl.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function extractImageUrls(content) {
	if (!Array.isArray(content)) return [];
	const urls = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type !== "image_url") continue;
		const url = resolveImageUrlPart(part);
		if (url) urls.push(url);
	}
	return urls;
}
function parseImageUrlToSource(url) {
	const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
	if (dataUriMatch) {
		const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
		const data = dataUriMatch[2] ?? "";
		const metadataParts = metadata.split(";").map((part) => normalizeOptionalString(part) ?? "").filter(Boolean);
		if (!metadataParts.some((part) => normalizeLowercaseStringOrEmpty(part) === "base64")) throw new Error("image_url data URI must be base64 encoded");
		if (!(normalizeOptionalString(data) ?? "")) throw new Error("image_url data URI is missing payload data");
		return {
			type: "base64",
			mediaType: metadataParts.find((part) => part.includes("/")),
			data
		};
	}
	return {
		type: "url",
		url
	};
}
function resolveActiveTurnContext(messagesUnknown) {
	const messages = asMessages(messagesUnknown);
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") continue;
		const role = normalizeOptionalString(msg.role) ?? "";
		const normalizedRole = role === "function" ? "tool" : role;
		if (normalizedRole !== "user" && normalizedRole !== "tool") continue;
		return {
			activeTurnIndex: i,
			activeUserMessageIndex: normalizedRole === "user" ? i : -1,
			urls: normalizedRole === "user" ? extractImageUrls(msg.content) : []
		};
	}
	return {
		activeTurnIndex: -1,
		activeUserMessageIndex: -1,
		urls: []
	};
}
async function resolveImagesForRequest(activeTurnContext, limits) {
	const urls = activeTurnContext.urls;
	if (urls.length === 0) return [];
	if (urls.length > limits.maxImageParts) throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
	const images = [];
	let totalBytes = 0;
	for (const url of urls) {
		const source = parseImageUrlToSource(url);
		if (source.type === "base64") {
			const sourceBytes = estimateBase64DecodedBytes(source.data);
			if (totalBytes + sourceBytes > limits.maxTotalImageBytes) throw new Error(`Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`);
		}
		const image = await extractImageContentFromSource(source, limits.images);
		totalBytes += estimateBase64DecodedBytes(image.data);
		if (totalBytes > limits.maxTotalImageBytes) throw new Error(`Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`);
		images.push(image);
	}
	return images;
}
const testOnlyOpenAiHttp = {
	resolveImagesForRequest,
	resolveOpenAiChatCompletionsLimits,
	resolveChatCompletionUsage
};
function buildAgentPrompt(messagesUnknown, activeUserMessageIndex) {
	const messages = asMessages(messagesUnknown);
	const systemParts = [];
	const conversationEntries = [];
	for (const [i, msg] of messages.entries()) {
		if (!msg || typeof msg !== "object") continue;
		const role = normalizeOptionalString(msg.role) ?? "";
		const content = extractTextContent(msg.content).trim();
		const hasImage = extractImageUrls(msg.content).length > 0;
		if (!role) continue;
		if (role === "system" || role === "developer") {
			if (content) systemParts.push(content);
			continue;
		}
		const normalizedRole = role === "function" ? "tool" : role;
		if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") continue;
		const assistantToolCalls = normalizedRole === "assistant" ? extractAssistantToolCalls(msg.tool_calls) : [];
		const assistantToolCallsSummary = assistantToolCalls.length > 0 ? renderAssistantToolCalls(assistantToolCalls) : "";
		const messageContent = [normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex ? IMAGE_ONLY_USER_MESSAGE : content, assistantToolCallsSummary].filter((part) => Boolean(part)).join("\n");
		if (!messageContent) continue;
		const name = normalizeOptionalString(msg.name) ?? "";
		const toolCallId = normalizeOptionalString(msg.tool_call_id) ?? "";
		const sender = normalizedRole === "assistant" ? "Assistant" : normalizedRole === "user" ? "User" : toolCallId ? `Tool:${toolCallId}` : name ? `Tool:${name}` : "Tool";
		conversationEntries.push({
			role: normalizedRole,
			entry: {
				sender,
				body: messageContent
			},
			internalStreamError: normalizedRole === "assistant" && normalizeOptionalString(msg.stopReason) === "error" && messageContent.trim() === "[assistant turn failed before producing content]"
		});
	}
	return {
		message: buildAgentMessageFromConversationEntries(conversationEntries),
		extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : void 0
	};
}
function coerceRequest(val) {
	if (!val || typeof val !== "object") return {};
	return val;
}
function resolveAgentResponseText(result) {
	const payloads = result?.payloads;
	if (!Array.isArray(payloads) || payloads.length === 0) return "No response from OpenClaw.";
	return payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") || "No response from OpenClaw.";
}
function resolveAgentResponseCommentary(result) {
	const payloads = result?.payloads;
	if (!Array.isArray(payloads) || payloads.length === 0) return "";
	return payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n");
}
function resolveAgentRunUsage(result) {
	const agentMeta = result?.meta?.agentMeta;
	const primary = normalizeUsage(agentMeta?.usage);
	if (hasNonzeroUsage(primary)) return primary;
	const fallback = normalizeUsage(agentMeta?.lastCallUsage);
	if (hasNonzeroUsage(fallback)) return fallback;
	return primary ?? fallback;
}
function resolveStopReasonAndPendingToolCalls(meta) {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {
		stopReason: void 0,
		pendingToolCalls: void 0
	};
	const stopReasonRaw = meta.stopReason;
	const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw : void 0;
	const pendingRaw = meta.pendingToolCalls;
	if (!Array.isArray(pendingRaw)) return {
		stopReason,
		pendingToolCalls: void 0
	};
	const pendingToolCalls = [];
	for (const call of pendingRaw) {
		const id = typeof call?.id === "string" ? call.id.trim() : "";
		const name = typeof call?.name === "string" ? call.name.trim() : "";
		const argsValue = call?.arguments;
		const argumentsValue = typeof argsValue === "string" ? argsValue : argsValue == null ? "" : JSON.stringify(argsValue);
		if (!id || !name) continue;
		pendingToolCalls.push({
			id,
			name,
			arguments: argumentsValue
		});
	}
	return {
		stopReason,
		pendingToolCalls
	};
}
function resolveChatCompletionUsage(result) {
	return toOpenAiChatCompletionsUsage(resolveAgentRunUsage(result));
}
function resolveIncludeUsageForStreaming(payload) {
	const streamOptions = payload.stream_options;
	if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) return false;
	return streamOptions.include_usage === true;
}
function resolveResponseFormat(value) {
	if (value == null) return;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("response_format must be an object");
	const obj = value;
	const type = obj.type;
	if (type !== "text" && type !== "json_object" && type !== "json_schema") throw new Error("response_format.type must be text, json_object, or json_schema");
	return obj;
}
function resolveErrorMessage(err) {
	if (err instanceof Error) {
		const message = err.message.trim();
		if (message) return message;
	}
	return String(err);
}
async function handleOpenAiHttpRequest(req, res, opts) {
	const limits = resolveOpenAiChatCompletionsLimits(opts.config);
	const handled = await handleGatewayPostJsonEndpoint(req, res, {
		pathname: "/v1/chat/completions",
		requiredOperatorMethod: "chat.send",
		resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes
	});
	if (handled === false) return false;
	if (!handled) return true;
	const payload = coerceRequest(handled.body);
	const stream = Boolean(payload.stream);
	const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
	const model = typeof payload.model === "string" ? payload.model : "openclaw";
	const user = typeof payload.user === "string" ? payload.user : void 0;
	const maxTokens = typeof payload.max_completion_tokens === "number" ? payload.max_completion_tokens : typeof payload.max_tokens === "number" ? payload.max_tokens : void 0;
	const temperature = typeof payload.temperature === "number" ? payload.temperature : void 0;
	const topP = typeof payload.top_p === "number" ? payload.top_p : void 0;
	let responseFormat;
	try {
		responseFormat = resolveResponseFormat(payload.response_format);
	} catch (err) {
		sendJson(res, 400, { error: {
			message: `Invalid response_format: ${resolveErrorMessage(err)}`,
			type: "invalid_request_error"
		} });
		return true;
	}
	const samplingError = validateOpenAiSamplingParams({
		temperature: payload.temperature,
		topP: payload.top_p
	});
	if (samplingError) {
		sendJson(res, 400, { error: {
			message: samplingError,
			type: "invalid_request_error"
		} });
		return true;
	}
	const streamParams = maxTokens !== void 0 || temperature !== void 0 || topP !== void 0 || responseFormat !== void 0 ? {
		...maxTokens !== void 0 ? { maxTokens } : {},
		...temperature !== void 0 ? { temperature } : {},
		...topP !== void 0 ? { topP } : {},
		...responseFormat !== void 0 ? { responseFormat } : {}
	} : void 0;
	const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
		req,
		model,
		user,
		sessionPrefix: "openai",
		defaultMessageChannel: "webchat",
		useMessageChannelHeader: true
	});
	const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
		req,
		agentId,
		model
	});
	if (modelError) {
		sendJson(res, 400, { error: {
			message: modelError,
			type: "invalid_request_error"
		} });
		return true;
	}
	const activeTurnContext = resolveActiveTurnContext(payload.messages);
	const prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);
	let resolvedClientTools = [];
	let toolChoicePrompt;
	try {
		const toolChoiceResult = applyChatToolChoice({
			tools: extractClientToolsFromChatRequest(payload.tools),
			toolChoice: payload.tool_choice
		});
		resolvedClientTools = toolChoiceResult.tools;
		toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
	} catch (err) {
		sendJson(res, 400, { error: {
			message: `Invalid tools/tool_choice: ${resolveErrorMessage(err)}`,
			type: "invalid_request_error"
		} });
		return true;
	}
	let images = [];
	try {
		images = await resolveImagesForRequest(activeTurnContext, limits);
	} catch (err) {
		logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
		sendJson(res, 400, { error: {
			message: "Invalid image_url content in `messages`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	if (!prompt.message && images.length === 0) {
		sendJson(res, 400, { error: {
			message: "Missing user message in `messages`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const runId = `chatcmpl_${randomUUID()}`;
	const deps = createDefaultDeps();
	const abortController = new AbortController();
	const mergedExtraSystemPrompt = [prompt.extraSystemPrompt, toolChoicePrompt].filter((part) => Boolean(part)).join("\n\n");
	const commandInput = buildAgentCommandInput({
		prompt: {
			message: prompt.message,
			extraSystemPrompt: mergedExtraSystemPrompt || void 0,
			images: images.length > 0 ? images : void 0
		},
		clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : void 0,
		modelOverride,
		sessionKey,
		runId,
		messageChannel,
		abortSignal: abortController.signal,
		streamParams
	});
	if (!stream) {
		const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
		try {
			const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
			if (abortController.signal.aborted) return true;
			const usage = resolveChatCompletionUsage(result);
			const meta = result?.meta;
			const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
			if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
				const commentary = resolveAgentResponseCommentary(result);
				sendJson(res, 200, {
					id: runId,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1e3),
					model,
					choices: [{
						index: 0,
						message: {
							role: "assistant",
							content: commentary,
							tool_calls: pendingToolCalls.map((call) => ({
								id: call.id,
								type: "function",
								function: {
									name: call.name,
									arguments: call.arguments
								}
							}))
						},
						finish_reason: "tool_calls"
					}],
					usage
				});
				return true;
			}
			const content = resolveAgentResponseText(result);
			sendJson(res, 200, {
				id: runId,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1e3),
				model,
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content
					},
					finish_reason: "stop"
				}],
				usage
			});
		} catch (err) {
			if (abortController.signal.aborted) return true;
			logWarn(`openai-compat: chat completion failed: ${String(err)}`);
			if (isClientToolNameConflictError(err)) {
				sendJson(res, 400, { error: {
					message: "invalid tool configuration",
					type: "invalid_request_error"
				} });
				return true;
			}
			const mapped = resolveOpenAiCompatError(err);
			if (mapped) {
				sendJson(res, mapped.status, { error: mapped.error });
				return true;
			}
			sendJson(res, 500, { error: {
				message: "internal error",
				type: "api_error"
			} });
		} finally {
			stopWatchingDisconnect();
		}
		return true;
	}
	setSseHeaders(res);
	let wroteRole = false;
	let wroteStopChunk = false;
	let sawAssistantDelta = false;
	let finalUsage;
	let finalizeRequested = false;
	let finalizeFinishReason = "stop";
	let resultResolved = false;
	let closed = false;
	let stopWatchingDisconnect = () => {};
	const maybeFinalize = () => {
		if (closed || !finalizeRequested) return;
		if (!resultResolved) return;
		if (streamIncludeUsage && !finalUsage) return;
		closed = true;
		stopWatchingDisconnect();
		unsubscribe();
		if (!wroteStopChunk) {
			writeAssistantFinishChunk(res, {
				runId,
				model,
				finishReason: finalizeFinishReason
			});
			wroteStopChunk = true;
		}
		if (streamIncludeUsage && finalUsage) writeUsageChunk(res, {
			runId,
			model,
			usage: finalUsage
		});
		writeDone(res);
		res.end();
	};
	const requestFinalize = (finishReason = "stop") => {
		finalizeFinishReason = finishReason;
		finalizeRequested = true;
		maybeFinalize();
	};
	const unsubscribe = onAgentEvent((evt) => {
		if (evt.runId !== runId) return;
		if (closed) return;
		if (evt.stream === "assistant") {
			const content = resolveAssistantStreamDeltaText(evt) ?? "";
			if (!content) return;
			if (!wroteRole) {
				wroteRole = true;
				writeAssistantRoleChunk(res, {
					runId,
					model
				});
			}
			sawAssistantDelta = true;
			writeAssistantContentChunk(res, {
				runId,
				model,
				content,
				finishReason: null
			});
			return;
		}
		if (evt.stream === "lifecycle") {
			const phase = evt.data?.phase;
			if (phase === "end" || phase === "error") requestFinalize();
		}
	});
	stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
		closed = true;
		unsubscribe();
	});
	wroteRole = true;
	writeAssistantRoleChunk(res, {
		runId,
		model
	});
	(async () => {
		try {
			const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
			resultResolved = true;
			if (closed) return;
			finalUsage = resolveChatCompletionUsage(result);
			const meta = result?.meta;
			const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
			if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
				if (!wroteRole) {
					wroteRole = true;
					writeAssistantRoleChunk(res, {
						runId,
						model
					});
				}
				if (!sawAssistantDelta) {
					const commentary = resolveAgentResponseCommentary(result);
					if (commentary) {
						sawAssistantDelta = true;
						writeAssistantContentChunk(res, {
							runId,
							model,
							content: commentary,
							finishReason: null
						});
					}
				}
				writeAssistantToolCallsIncrementalChunks(res, {
					runId,
					model,
					toolCalls: pendingToolCalls
				});
				requestFinalize("tool_calls");
				return;
			}
			if (!sawAssistantDelta) {
				if (!wroteRole) {
					wroteRole = true;
					writeAssistantRoleChunk(res, {
						runId,
						model
					});
				}
				const content = resolveAgentResponseText(result);
				sawAssistantDelta = true;
				writeAssistantContentChunk(res, {
					runId,
					model,
					content,
					finishReason: null
				});
			}
			requestFinalize();
		} catch (err) {
			resultResolved = true;
			if (closed || abortController.signal.aborted) return;
			logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
			if (isClientToolNameConflictError(err)) {
				closed = true;
				stopWatchingDisconnect();
				unsubscribe();
				writeSse(res, { error: {
					message: "invalid tool configuration",
					type: "invalid_request_error"
				} });
				writeDone(res);
				res.end();
				return;
			}
			const mapped = resolveOpenAiCompatError(err);
			if (mapped) {
				closed = true;
				stopWatchingDisconnect();
				unsubscribe();
				writeSse(res, { error: mapped.error });
				writeDone(res);
				res.end();
				return;
			}
			writeAssistantContentChunk(res, {
				runId,
				model,
				content: "Error: internal error",
				finishReason: "stop"
			});
			wroteStopChunk = true;
			finalUsage = {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0
			};
			emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: { phase: "error" }
			});
			requestFinalize();
		} finally {
			if (!closed) emitAgentEvent({
				runId,
				stream: "lifecycle",
				data: { phase: "end" }
			});
		}
	})();
	return true;
}
//#endregion
export { testOnlyOpenAiHttp as __testOnlyOpenAiHttp, testOnlyOpenAiHttp, handleOpenAiHttpRequest };
