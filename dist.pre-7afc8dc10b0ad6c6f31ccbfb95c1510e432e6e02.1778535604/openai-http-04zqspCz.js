import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { n as defaultRuntime } from "./runtime-Bd9_VI2J.js";
import { a as logWarn } from "./logger-C9OJkRW0.js";
import { i as emitAgentEvent, l as onAgentEvent } from "./agent-events-D-QDM7gD.js";
import { i as hasNonzeroUsage, o as normalizeUsage, s as toOpenAiChatCompletionsUsage } from "./usage-CGE_H8UJ.js";
import { n as estimateBase64DecodedBytes } from "./base64-BBPOEgPt.js";
import { a as extractImageContentFromSource, n as DEFAULT_INPUT_IMAGE_MIMES, o as normalizeMimeList, r as DEFAULT_INPUT_TIMEOUT_MS, t as DEFAULT_INPUT_IMAGE_MAX_BYTES } from "./input-files-QGyp_Dmd.js";
import { r as agentCommandFromIngress } from "./agent-command-CQcRxvKA.js";
import { t as createDefaultDeps } from "./deps-8hw6gtrc.js";
import "./agent-BQ6pAm65.js";
import { c as watchClientDisconnect, i as sendJson, l as writeDone, s as setSseHeaders } from "./http-common-CERJMbct.js";
import { l as resolveOpenAiCompatibleHttpOperatorScopes, u as resolveOpenAiCompatibleHttpSenderIsOwner } from "./http-auth-utils-CBXICEUh.js";
import { a as resolveGatewayRequestContext, o as resolveOpenAiCompatModelOverride } from "./http-utils-DY5IWFQh.js";
import { t as handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers-DYkQOyxd.js";
import { n as buildAgentMessageFromConversationEntries, r as resolveAssistantStreamDeltaText, t as normalizeInputHostnameAllowlist } from "./input-allowlist-Bg2zAQXt.js";
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
		model: params.modelOverride,
		sessionKey: params.sessionKey,
		runId: params.runId,
		deliver: false,
		messageChannel: params.messageChannel,
		bestEffortDeliver: false,
		senderIsOwner: params.senderIsOwner,
		allowModelOverride: true,
		abortSignal: params.abortSignal
	};
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
function writeAssistantStopChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [{
			index: 0,
			delta: {},
			finish_reason: "stop"
		}]
	});
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
const __testOnlyOpenAiHttp = {
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
		const messageContent = normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex ? IMAGE_ONLY_USER_MESSAGE : content;
		if (!messageContent) continue;
		const name = normalizeOptionalString(msg.name) ?? "";
		const sender = normalizedRole === "assistant" ? "Assistant" : normalizedRole === "user" ? "User" : name ? `Tool:${name}` : "Tool";
		conversationEntries.push({
			role: normalizedRole,
			entry: {
				sender,
				body: messageContent
			}
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
function resolveAgentRunUsage(result) {
	const agentMeta = result?.meta?.agentMeta;
	const primary = normalizeUsage(agentMeta?.usage);
	if (hasNonzeroUsage(primary)) return primary;
	const fallback = normalizeUsage(agentMeta?.lastCallUsage);
	if (hasNonzeroUsage(fallback)) return fallback;
	return primary ?? fallback;
}
function resolveChatCompletionUsage(result) {
	return toOpenAiChatCompletionsUsage(resolveAgentRunUsage(result));
}
function resolveIncludeUsageForStreaming(payload) {
	const streamOptions = payload.stream_options;
	if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) return false;
	return streamOptions.include_usage === true;
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
	const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);
	const payload = coerceRequest(handled.body);
	const stream = Boolean(payload.stream);
	const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
	const model = typeof payload.model === "string" ? payload.model : "openclaw";
	const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
		req,
		model,
		user: typeof payload.user === "string" ? payload.user : void 0,
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
	const commandInput = buildAgentCommandInput({
		prompt: {
			message: prompt.message,
			extraSystemPrompt: prompt.extraSystemPrompt,
			images: images.length > 0 ? images : void 0
		},
		modelOverride,
		sessionKey,
		runId,
		messageChannel,
		abortSignal: abortController.signal,
		senderIsOwner
	});
	if (!stream) {
		const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
		try {
			const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
			if (abortController.signal.aborted) return true;
			const content = resolveAgentResponseText(result);
			const usage = resolveChatCompletionUsage(result);
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
	let closed = false;
	let stopWatchingDisconnect = () => {};
	const maybeFinalize = () => {
		if (closed || !finalizeRequested) return;
		if (streamIncludeUsage && !finalUsage) return;
		closed = true;
		stopWatchingDisconnect();
		unsubscribe();
		if (!wroteStopChunk) {
			writeAssistantStopChunk(res, {
				runId,
				model
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
	const requestFinalize = () => {
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
			if (closed) return;
			finalUsage = resolveChatCompletionUsage(result);
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
			if (closed || abortController.signal.aborted) return;
			logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
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
export { __testOnlyOpenAiHttp, handleOpenAiHttpRequest };
