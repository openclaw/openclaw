import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { j as resolveProviderStreamFn } from "./provider-runtime-D8jQEgmu.js";
import { t as MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "./assistant-error-format-CuUvHfKt.js";
import { n as resolveProviderEndpoint } from "./provider-attribution-B2QMzk1g.js";
import { c as hasCopilotVisionInput, o as buildCopilotDynamicHeaders } from "./copilot-dynamic-headers-CVy4X1Kj.js";
import { r as getModelProviderRequestTransport } from "./provider-request-config-DxK6PUHR.js";
import { E as buildGuardedModelFetch, _ as mergeTransportHeaders, b as transformTransportMessages, f as coerceTransportToolCallArguments, g as finalizeTransportStream, h as failTransportStream, i as createOpenAIResponsesTransportStreamFn, m as createWritableTransportEventStream, n as createAzureOpenAIResponsesTransportStreamFn, p as createEmptyTransportUsage, r as createOpenAICompletionsTransportStreamFn, v as sanitizeNonEmptyTransportPayloadText, y as sanitizeTransportPayloadText } from "./openai-transport-stream-Pgx5hpN7.js";
import { n as applyAnthropicPayloadPolicyToParams, r as resolveAnthropicPayloadPolicy } from "./anthropic-payload-policy-SPPqOSER.js";
import { r as getModelProviderLocalService } from "./provider-local-service-43HU15Bt.js";
import { calculateCost, getApiProvider, getEnvApiKey, parseStreamingJson, registerApiProvider } from "@earendil-works/pi-ai";
//#region src/agents/custom-api-registry.ts
const CUSTOM_API_SOURCE_PREFIX = "openclaw-custom-api:";
function getCustomApiRegistrySourceId(api) {
	return `${CUSTOM_API_SOURCE_PREFIX}${api}`;
}
function ensureCustomApiRegistered(api, streamFn) {
	if (getApiProvider(api)) return false;
	registerApiProvider({
		api,
		stream: (model, context, options) => streamFn(model, context, options),
		streamSimple: (model, context, options) => streamFn(model, context, options)
	}, getCustomApiRegistrySourceId(api));
	return true;
}
//#endregion
//#region src/agents/json-unsafe-integers.ts
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
//#region src/agents/anthropic-transport-stream.ts
const CLAUDE_CODE_VERSION = "2.1.75";
const CLAUDE_CODE_TOOL_LOOKUP = new Map([
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch"
].map((tool) => [normalizeLowercaseStringOrEmpty(tool), tool]));
const EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT = ".";
function isClaudeOpus47Model(modelId) {
	return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}
function isClaudeOpus46Model(modelId) {
	return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}
function supportsAdaptiveThinking(modelId) {
	return isClaudeOpus47Model(modelId) || isClaudeOpus46Model(modelId) || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6");
}
function mapThinkingLevelToEffort(level, modelId) {
	switch (level) {
		case "minimal":
		case "low": return "low";
		case "medium": return "medium";
		case "xhigh":
			if (isClaudeOpus47Model(modelId)) return "xhigh";
			return isClaudeOpus46Model(modelId) ? "max" : "high";
		default: return "high";
	}
}
function clampReasoningLevel(level) {
	return level === "xhigh" ? "high" : level;
}
function resolvePositiveAnthropicMaxTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const floored = Math.floor(value);
	return floored > 0 ? floored : void 0;
}
function resolveAnthropicMessagesMaxTokens(params) {
	const requested = resolvePositiveAnthropicMaxTokens(params.requestedMaxTokens);
	if (requested !== void 0) return requested;
	const modelMax = resolvePositiveAnthropicMaxTokens(params.modelMaxTokens);
	return modelMax !== void 0 ? Math.min(modelMax, 32e3) : void 0;
}
function adjustMaxTokensForThinking(params) {
	const budgets = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
		...params.customBudgets
	};
	const minOutputTokens = 1024;
	let thinkingBudget = budgets[clampReasoningLevel(params.reasoningLevel)];
	const maxTokens = Math.min(params.baseMaxTokens + thinkingBudget, params.modelMaxTokens);
	if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
	return {
		maxTokens,
		thinkingBudget
	};
}
function isAnthropicOAuthToken(apiKey) {
	return apiKey.includes("sk-ant-oat");
}
function isDirectAnthropicModel(model) {
	if (normalizeLowercaseStringOrEmpty(model.provider) !== "anthropic") return false;
	const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
	return endpointClass === "default" || endpointClass === "anthropic-public";
}
function isKimiAnthropicProvider(provider) {
	return /^kimi(?:-|$)/.test(normalizeLowercaseStringOrEmpty(provider ?? ""));
}
function supportsReasoningContentReplay(model) {
	return resolveProviderEndpoint(model.baseUrl).endpointClass === "xiaomi-native";
}
function buildAnthropicBetaHeader(model, betaFeatures, params) {
	if (!isDirectAnthropicModel(model)) return;
	return params.oauth ? `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}` : betaFeatures.join(",");
}
function toClaudeCodeName(name) {
	return CLAUDE_CODE_TOOL_LOOKUP.get(normalizeLowercaseStringOrEmpty(name)) ?? name;
}
function fromClaudeCodeName(name, tools) {
	if (tools && tools.length > 0) {
		const lowerName = normalizeLowercaseStringOrEmpty(name);
		const matchedTool = tools.find((tool) => normalizeLowercaseStringOrEmpty(tool.name) === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
}
function convertContentBlocks(content) {
	if (!content.some((item) => item.type === "image")) return sanitizeNonEmptyTransportPayloadText(content.map((item) => "text" in item ? item.text : "").join("\n"));
	const blocks = [];
	let hasTextBlock = false;
	for (const block of content) if (block.type === "text") {
		const text = sanitizeTransportPayloadText(block.text);
		if (text.trim().length > 0) {
			blocks.push({
				type: "text",
				text
			});
			hasTextBlock = true;
		}
	} else blocks.push({
		type: "image",
		source: {
			type: "base64",
			media_type: block.mimeType,
			data: block.data
		}
	});
	if (!hasTextBlock) return [{
		type: "text",
		text: "(see attached image)"
	}, ...blocks];
	return blocks;
}
function normalizeToolCallId(id) {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function convertAnthropicMessages(messages, model, isOAuthToken, options) {
	const params = [];
	const allowReasoningContentReplay = options?.allowReasoningContentReplay === true;
	const transformedMessages = transformTransportMessages(messages, model, normalizeToolCallId);
	for (let i = 0; i < transformedMessages.length; i += 1) {
		const msg = transformedMessages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) params.push({
					role: "user",
					content: sanitizeTransportPayloadText(msg.content)
				});
				continue;
			}
			const blocks = msg.content.map((item) => item.type === "text" ? {
				type: "text",
				text: sanitizeTransportPayloadText(item.text)
			} : {
				type: "image",
				source: {
					type: "base64",
					media_type: item.mimeType,
					data: item.data
				}
			});
			let filteredBlocks = model.input.includes("image") ? blocks : blocks.filter((block) => block.type !== "image");
			filteredBlocks = filteredBlocks.filter((block) => block.type !== "text" || block.text.trim().length > 0);
			if (filteredBlocks.length === 0) continue;
			params.push({
				role: "user",
				content: filteredBlocks
			});
			continue;
		}
		if (msg.role === "assistant") {
			const blocks = [];
			const reasoningContent = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) blocks.push({
						type: "text",
						text: sanitizeTransportPayloadText(block.text)
					});
					continue;
				}
				if (block.type === "thinking") {
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) blocks.push({
						type: "text",
						text: sanitizeTransportPayloadText(block.thinking)
					});
					else {
						const thinking = sanitizeTransportPayloadText(block.thinking);
						if (block.thinkingSignature === "reasoning_content") {
							if (allowReasoningContentReplay) {
								blocks.push({
									type: "thinking",
									thinking,
									signature: block.thinkingSignature
								});
								reasoningContent.push(thinking);
							}
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking,
							signature: block.thinkingSignature
						});
					}
					continue;
				}
				if (block.type === "toolCall") blocks.push({
					type: "tool_use",
					id: block.id,
					name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
					input: coerceTransportToolCallArguments(block.arguments)
				});
			}
			if (blocks.length > 0) {
				const assistantMsg = {
					role: "assistant",
					content: blocks
				};
				if (reasoningContent.length > 0) assistantMsg.reasoning_content = reasoningContent.join("\n");
				else if (allowReasoningContentReplay) blocks.unshift({
					type: "thinking",
					thinking: "",
					signature: "reasoning_content"
				});
				params.push(assistantMsg);
			}
			continue;
		}
		if (msg.role === "toolResult") {
			const toolResult = msg;
			const toolResults = [{
				type: "tool_result",
				tool_use_id: toolResult.toolCallId,
				content: convertContentBlocks(toolResult.content),
				is_error: toolResult.isError
			}];
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j];
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError
				});
				j += 1;
			}
			i = j - 1;
			params.push({
				role: "user",
				content: toolResults
			});
		}
	}
	return params;
}
function ensureNonEmptyAnthropicMessages(messages) {
	return messages.length > 0 ? messages : [{
		role: "user",
		content: EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT
	}];
}
function convertAnthropicTools(tools, isOAuthToken) {
	if (!tools) return [];
	const converted = [];
	for (const tool of tools) {
		const parameters = tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters) ? tool.parameters : void 0;
		if (!parameters) continue;
		converted.push({
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			input_schema: {
				type: "object",
				properties: parameters.properties || {},
				required: parameters.required || []
			}
		});
	}
	return converted;
}
function parseAnthropicToolCallArguments(inputJson) {
	return parseJsonObjectPreservingUnsafeIntegers(inputJson) ?? parseStreamingJson(inputJson);
}
function mapStopReason(reason) {
	switch (reason) {
		case "end_turn": return "stop";
		case "max_tokens": return "length";
		case "tool_use": return "toolUse";
		case "pause_turn": return "stop";
		case "refusal":
		case "sensitive": return "error";
		case "stop_sequence": return "stop";
		default: throw new Error(`Unhandled stop reason: ${String(reason)}`);
	}
}
function resolveAnthropicMessagesUrl(baseUrl) {
	const normalized = (baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}
function createAbortError(signal) {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	const error = reason === void 0 ? /* @__PURE__ */ new Error("Request was aborted") : new Error("Request was aborted", { cause: reason });
	error.name = "AbortError";
	return error;
}
function readAnthropicSseChunk(reader, signal) {
	if (!signal) return reader.read();
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reader.cancel(signal.reason).catch(() => void 0);
			reject(createAbortError(signal));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then((result) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		}, (error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
function parseAnthropicSseEventData(data) {
	try {
		return JSON.parse(data);
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
		throw error;
	}
}
async function* parseAnthropicSseBody(body, signal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await readAnthropicSseChunk(reader, signal);
			if (done) break;
			buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll("\r\n", "\n");
			let frameEnd = buffer.indexOf("\n\n");
			while (frameEnd >= 0) {
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
				if (data && data !== "[DONE]") yield parseAnthropicSseEventData(data);
				frameEnd = buffer.indexOf("\n\n");
			}
		}
		const tail = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n").trim();
		if (tail) {
			const data = tail.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
			if (data && data !== "[DONE]") yield parseAnthropicSseEventData(data);
		}
	} finally {
		reader.releaseLock();
	}
}
function createAnthropicMessagesClient(params) {
	const url = resolveAnthropicMessagesUrl(params.baseURL);
	return { messages: { async *stream(body, options) {
		const headers = mergeTransportHeaders({
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			...params.apiKey ? { "x-api-key": params.apiKey } : {},
			...params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}
		}, params.defaultHeaders);
		const response = await params.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options?.signal
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(detail || `Anthropic Messages request failed with HTTP ${response.status}`);
		}
		if (!response.body) return;
		yield* parseAnthropicSseBody(response.body, options?.signal);
	} } };
}
function createAnthropicTransportClient(params) {
	const { model, context, apiKey, options } = params;
	const needsInterleavedBeta = (options?.interleavedThinking ?? true) && !supportsAdaptiveThinking(model.id);
	const fetch = isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true ? buildGuardedModelFetch(model, void 0, { sanitizeSse: false }) : buildGuardedModelFetch(model);
	if (model.provider === "github-copilot") {
		const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
		return {
			client: createAnthropicMessagesClient({
				apiKey: null,
				authToken: apiKey,
				baseURL: model.baseUrl,
				defaultHeaders: mergeTransportHeaders({
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}
				}, model.headers, buildCopilotDynamicHeaders({
					messages: context.messages,
					hasImages: hasCopilotVisionInput(context.messages)
				}), options?.headers),
				fetch
			}),
			isOAuthToken: false
		};
	}
	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
	if (needsInterleavedBeta) betaFeatures.push("interleaved-thinking-2025-05-14");
	if (isAnthropicOAuthToken(apiKey)) {
		const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: true });
		return {
			client: createAnthropicMessagesClient({
				apiKey: null,
				authToken: apiKey,
				baseURL: model.baseUrl,
				defaultHeaders: mergeTransportHeaders({
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...betaHeader ? { "anthropic-beta": betaHeader } : {},
					"user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
					"x-app": "cli"
				}, model.headers, options?.headers),
				fetch
			}),
			isOAuthToken: true
		};
	}
	const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: false });
	return {
		client: createAnthropicMessagesClient({
			apiKey,
			baseURL: model.baseUrl,
			defaultHeaders: mergeTransportHeaders({
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...betaHeader ? { "anthropic-beta": betaHeader } : {}
			}, model.headers, options?.headers),
			fetch
		}),
		isOAuthToken: false
	};
}
function buildAnthropicParams(model, context, isOAuthToken, options) {
	const maxTokens = resolveAnthropicMessagesMaxTokens({
		modelMaxTokens: model.maxTokens,
		requestedMaxTokens: options?.maxTokens
	});
	if (maxTokens === void 0) throw new Error(`Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`);
	const payloadPolicy = resolveAnthropicPayloadPolicy({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		cacheRetention: options?.cacheRetention,
		enableCacheControl: true
	});
	const params = {
		model: model.id,
		messages: ensureNonEmptyAnthropicMessages(convertAnthropicMessages(context.messages, model, isOAuthToken, { allowReasoningContentReplay: supportsReasoningContentReplay(model) })),
		max_tokens: maxTokens,
		stream: true
	};
	if (isOAuthToken) params.system = [{
		type: "text",
		text: "You are Claude Code, Anthropic's official CLI for Claude."
	}, ...context.systemPrompt ? [{
		type: "text",
		text: sanitizeTransportPayloadText(context.systemPrompt)
	}] : []];
	else if (context.systemPrompt) params.system = [{
		type: "text",
		text: sanitizeTransportPayloadText(context.systemPrompt)
	}];
	if (options?.temperature !== void 0 && !options.thinkingEnabled) params.temperature = options.temperature;
	if (context.tools) params.tools = convertAnthropicTools(context.tools, isOAuthToken);
	if (model.reasoning) {
		if (options?.thinkingEnabled) if (supportsAdaptiveThinking(model.id)) {
			params.thinking = { type: "adaptive" };
			if (options.effort) params.output_config = { effort: options.effort };
		} else params.thinking = {
			type: "enabled",
			budget_tokens: options.thinkingBudgetTokens || 1024
		};
		else if (options?.thinkingEnabled === false) params.thinking = { type: "disabled" };
	}
	if (options?.metadata && typeof options.metadata.user_id === "string") params.metadata = { user_id: options.metadata.user_id };
	if (options?.toolChoice) params.tool_choice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
	applyAnthropicPayloadPolicyToParams(params, payloadPolicy);
	return params;
}
function resolveAnthropicTransportOptions(model, options, apiKey) {
	const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
		modelMaxTokens: model.maxTokens,
		requestedMaxTokens: options?.maxTokens
	});
	if (baseMaxTokens === void 0) throw new Error(`Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`);
	const reasoningModelMaxTokens = resolvePositiveAnthropicMaxTokens(model.maxTokens) ?? baseMaxTokens;
	const resolved = {
		temperature: options?.temperature,
		maxTokens: baseMaxTokens,
		signal: options?.signal,
		apiKey,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		interleavedThinking: options?.interleavedThinking,
		toolChoice: options?.toolChoice,
		thinkingBudgets: options?.thinkingBudgets,
		reasoning: options?.reasoning
	};
	if (!options?.reasoning) {
		resolved.thinkingEnabled = false;
		return resolved;
	}
	if (supportsAdaptiveThinking(model.id)) {
		resolved.thinkingEnabled = true;
		resolved.effort = mapThinkingLevelToEffort(options.reasoning, model.id);
		return resolved;
	}
	const adjusted = adjustMaxTokensForThinking({
		baseMaxTokens,
		modelMaxTokens: reasoningModelMaxTokens,
		reasoningLevel: options.reasoning,
		customBudgets: options.thinkingBudgets
	});
	resolved.maxTokens = adjusted.maxTokens;
	resolved.thinkingEnabled = true;
	resolved.thinkingBudgetTokens = adjusted.thinkingBudget;
	return resolved;
}
function createAnthropicMessagesTransportStreamFn() {
	return (rawModel, context, rawOptions) => {
		const model = rawModel;
		const options = rawOptions;
		const { eventStream, stream } = createWritableTransportEventStream();
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: model.provider,
				model: model.id,
				usage: createEmptyTransportUsage(),
				stopReason: "stop",
				timestamp: Date.now()
			};
			try {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
				if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
				const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
				const { client, isOAuthToken } = createAnthropicTransportClient({
					model,
					context,
					apiKey,
					options: transportOptions
				});
				let params = buildAnthropicParams(model, context, isOAuthToken, transportOptions);
				const nextParams = await transportOptions.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				const anthropicStream = client.messages.stream({
					...params,
					stream: true
				}, transportOptions.signal ? { signal: transportOptions.signal } : void 0);
				stream.push({
					type: "start",
					partial: output
				});
				const blocks = output.content;
				const allowReasoningContentReplay = supportsReasoningContentReplay(model);
				const reasoningContentThinkingBlocks = /* @__PURE__ */ new Map();
				const reasoningContentTextBlocks = /* @__PURE__ */ new Map();
				const eventIndexKey = (eventIndex) => typeof eventIndex === "number" ? eventIndex : -1;
				const appendReasoningContentThinkingDelta = (eventIndex, rawText) => {
					if (typeof rawText !== "string") return false;
					const text = sanitizeTransportPayloadText(rawText);
					if (text.length === 0) return false;
					const key = eventIndexKey(eventIndex);
					let contentIndex = reasoningContentThinkingBlocks.get(key);
					let block = contentIndex === void 0 ? void 0 : output.content[contentIndex];
					if (!block || block.type !== "thinking") {
						block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "reasoning_content"
						};
						output.content.push(block);
						contentIndex = output.content.length - 1;
						reasoningContentThinkingBlocks.set(key, contentIndex);
						stream.push({
							type: "thinking_start",
							contentIndex,
							partial: output
						});
					}
					block.thinking += text;
					block.thinkingSignature = "reasoning_content";
					stream.push({
						type: "thinking_delta",
						contentIndex,
						delta: text,
						partial: output
					});
					return true;
				};
				const appendReasoningContentTextDelta = (eventIndex, rawText) => {
					if (typeof rawText !== "string") return false;
					const text = sanitizeTransportPayloadText(rawText);
					if (text.length === 0) return false;
					const key = eventIndexKey(eventIndex);
					let contentIndex = reasoningContentTextBlocks.get(key);
					let block = contentIndex === void 0 ? void 0 : output.content[contentIndex];
					if (!block || block.type !== "text") {
						block = {
							type: "text",
							text: ""
						};
						output.content.push(block);
						contentIndex = output.content.length - 1;
						reasoningContentTextBlocks.set(key, contentIndex);
						stream.push({
							type: "text_start",
							contentIndex,
							partial: output
						});
					}
					block.text += text;
					stream.push({
						type: "text_delta",
						contentIndex,
						delta: text,
						partial: output
					});
					return true;
				};
				const finishReasoningContentSidecars = (eventIndex) => {
					const key = eventIndexKey(eventIndex);
					const thinkingContentIndex = reasoningContentThinkingBlocks.get(key);
					if (thinkingContentIndex !== void 0) {
						reasoningContentThinkingBlocks.delete(key);
						const block = output.content[thinkingContentIndex];
						if (block?.type === "thinking") stream.push({
							type: "thinking_end",
							contentIndex: thinkingContentIndex,
							content: block.thinking,
							partial: output
						});
					}
					const textContentIndex = reasoningContentTextBlocks.get(key);
					if (textContentIndex === void 0) return;
					reasoningContentTextBlocks.delete(key);
					const block = output.content[textContentIndex];
					if (block?.type === "text") stream.push({
						type: "text_end",
						contentIndex: textContentIndex,
						content: block.text,
						partial: output
					});
				};
				for await (const event of anthropicStream) {
					if (event.type === "error") {
						const error = event.error;
						throw new Error(error?.message || "Anthropic Messages stream failed");
					}
					if (event.type === "message_start") {
						const message = event.message;
						const usage = message?.usage ?? {};
						output.responseId = typeof message?.id === "string" ? message.id : void 0;
						output.usage.input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
						output.usage.output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
						output.usage.cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
						output.usage.cacheWrite = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
						continue;
					}
					if (event.type === "content_block_start") {
						const contentBlock = event.content_block;
						const index = typeof event.index === "number" ? event.index : -1;
						if (contentBlock?.type === "text") {
							const text = typeof contentBlock.text === "string" ? sanitizeTransportPayloadText(contentBlock.text) : "";
							const block = {
								type: "text",
								text,
								index
							};
							output.content.push(block);
							const contentIndex = output.content.length - 1;
							stream.push({
								type: "text_start",
								contentIndex,
								partial: output
							});
							if (text.length > 0) stream.push({
								type: "text_delta",
								contentIndex,
								delta: text,
								partial: output
							});
							continue;
						}
						if (contentBlock?.type === "thinking") {
							const thinking = typeof contentBlock.thinking === "string" ? sanitizeTransportPayloadText(contentBlock.thinking) : "";
							const block = {
								type: "thinking",
								thinking,
								thinkingSignature: typeof contentBlock.signature === "string" ? contentBlock.signature : "",
								index
							};
							output.content.push(block);
							const contentIndex = output.content.length - 1;
							stream.push({
								type: "thinking_start",
								contentIndex,
								partial: output
							});
							if (thinking.length > 0) stream.push({
								type: "thinking_delta",
								contentIndex,
								delta: thinking,
								partial: output
							});
							continue;
						}
						if (contentBlock?.type === "redacted_thinking") {
							const block = {
								type: "thinking",
								thinking: "[Reasoning redacted]",
								thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
								redacted: true,
								index
							};
							output.content.push(block);
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output
							});
							continue;
						}
						if (contentBlock?.type === "tool_use") {
							const block = {
								type: "toolCall",
								id: typeof contentBlock.id === "string" ? contentBlock.id : "",
								name: typeof contentBlock.name === "string" ? isOAuthToken ? fromClaudeCodeName(contentBlock.name, context.tools) : contentBlock.name : "",
								arguments: contentBlock.input && typeof contentBlock.input === "object" ? contentBlock.input : {},
								partialJson: "",
								index
							};
							output.content.push(block);
							stream.push({
								type: "toolcall_start",
								contentIndex: output.content.length - 1,
								partial: output
							});
						}
						continue;
					}
					if (event.type === "content_block_delta") {
						const delta = event.delta;
						let index = blocks.findIndex((block) => block.index === event.index);
						let block = blocks[index];
						if (allowReasoningContentReplay) {
							const appendedThinking = appendReasoningContentThinkingDelta(event.index, delta?.reasoning_content);
							const hasNativeAnthropicDelta = delta?.type === "text_delta" && typeof delta.text === "string" || delta?.type === "thinking_delta" && typeof delta.thinking === "string" || delta?.type === "input_json_delta" && typeof delta.partial_json === "string" || delta?.type === "signature_delta" && typeof delta.signature === "string";
							let appendedContent = false;
							if (!hasNativeAnthropicDelta && typeof delta?.content === "string" && delta.content.length > 0) {
								const text = sanitizeTransportPayloadText(delta.content);
								if (text.length > 0) if (block?.type === "text") {
									block.text += text;
									stream.push({
										type: "text_delta",
										contentIndex: index,
										delta: text,
										partial: output
									});
									appendedContent = true;
								} else appendedContent = appendReasoningContentTextDelta(event.index, text);
							}
							if ((appendedThinking || appendedContent) && !hasNativeAnthropicDelta) continue;
						}
						if (!block && delta?.type === "text_delta" && typeof delta.text === "string") {
							block = {
								type: "text",
								text: "",
								index: typeof event.index === "number" ? event.index : blocks.length
							};
							output.content.push(block);
							index = output.content.length - 1;
							stream.push({
								type: "text_start",
								contentIndex: index,
								partial: output
							});
						}
						if (block?.type === "text" && delta?.type === "text_delta" && typeof delta.text === "string") {
							block.text += delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: delta.text,
								partial: output
							});
							continue;
						}
						if (block?.type === "thinking" && delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
							block.thinking += delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: delta.thinking,
								partial: output
							});
							continue;
						}
						if (block?.type === "toolCall" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
							const partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
							block.partialJson = partialJson;
							block.arguments = parseAnthropicToolCallArguments(partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: delta.partial_json,
								partial: output
							});
							continue;
						}
						if (block?.type === "thinking" && delta?.type === "signature_delta" && typeof delta.signature === "string") block.thinkingSignature = delta.signature;
						continue;
					}
					if (event.type === "content_block_stop") {
						const index = blocks.findIndex((block) => block.index === event.index);
						const block = blocks[index];
						if (!block) {
							finishReasoningContentSidecars(event.index);
							continue;
						}
						delete block.index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output
							});
							finishReasoningContentSidecars(event.index);
							continue;
						}
						if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output
							});
							finishReasoningContentSidecars(event.index);
							continue;
						}
						if (block.type === "toolCall") {
							if (typeof block.partialJson === "string" && block.partialJson.length > 0) block.arguments = parseAnthropicToolCallArguments(block.partialJson);
							delete block.partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output
							});
							finishReasoningContentSidecars(event.index);
						}
						continue;
					}
					if (event.type === "message_delta") {
						const delta = event.delta;
						const usage = event.usage;
						if (delta?.stop_reason) output.stopReason = mapStopReason(delta.stop_reason);
						if (typeof usage?.input_tokens === "number") output.usage.input = usage.input_tokens;
						if (typeof usage?.output_tokens === "number") output.usage.output = usage.output_tokens;
						if (typeof usage?.cache_read_input_tokens === "number") output.usage.cacheRead = usage.cache_read_input_tokens;
						if (typeof usage?.cache_creation_input_tokens === "number") output.usage.cacheWrite = usage.cache_creation_input_tokens;
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					}
				}
				finalizeTransportStream({
					stream,
					output,
					signal: transportOptions.signal
				});
			} catch (error) {
				failTransportStream({
					stream,
					output,
					signal: options?.signal,
					error,
					cleanup: () => {
						for (const block of output.content) delete block.index;
					}
				});
			}
		})();
		return eventStream;
	};
}
//#endregion
//#region src/agents/provider-transport-stream.ts
const SUPPORTED_TRANSPORT_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"openai-completions",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai"
]);
const SIMPLE_TRANSPORT_API_ALIAS = {
	"openai-responses": "openclaw-openai-responses-transport",
	"openai-codex-responses": "openclaw-openai-responses-transport",
	"openai-completions": "openclaw-openai-completions-transport",
	"azure-openai-responses": "openclaw-azure-openai-responses-transport",
	"anthropic-messages": "openclaw-anthropic-messages-transport",
	"google-generative-ai": "openclaw-google-generative-ai-transport"
};
function createProviderOwnedGoogleTransportStreamFn(model, ctx) {
	return resolveProviderStreamFn({
		provider: model.provider,
		config: ctx?.cfg,
		workspaceDir: ctx?.workspaceDir,
		env: ctx?.env,
		context: {
			config: ctx?.cfg,
			agentDir: ctx?.agentDir,
			workspaceDir: ctx?.workspaceDir,
			provider: model.provider,
			modelId: model.id,
			model
		}
	}) ?? resolveProviderStreamFn({
		provider: "google",
		config: ctx?.cfg,
		workspaceDir: ctx?.workspaceDir,
		env: ctx?.env,
		context: {
			config: ctx?.cfg,
			agentDir: ctx?.agentDir,
			workspaceDir: ctx?.workspaceDir,
			provider: model.provider,
			modelId: model.id,
			model
		}
	}) ?? void 0;
}
function createSupportedTransportStreamFn(model, ctx) {
	switch (model.api) {
		case "openai-responses":
		case "openai-codex-responses": return createOpenAIResponsesTransportStreamFn();
		case "openai-completions": return createOpenAICompletionsTransportStreamFn();
		case "azure-openai-responses": return createAzureOpenAIResponsesTransportStreamFn();
		case "anthropic-messages": return createAnthropicMessagesTransportStreamFn();
		case "google-generative-ai": return createProviderOwnedGoogleTransportStreamFn(model, ctx);
		default: return;
	}
}
function hasOpenClawTransportRequirement(model) {
	const request = getModelProviderRequestTransport(model);
	return Boolean(request?.proxy || request?.tls || getModelProviderLocalService(model));
}
function isTransportAwareApiSupported(api) {
	return SUPPORTED_TRANSPORT_APIS.has(api);
}
function resolveTransportAwareSimpleApi(api) {
	return SIMPLE_TRANSPORT_API_ALIAS[api];
}
function createTransportAwareStreamFnForModel(model, ctx) {
	if (!hasOpenClawTransportRequirement(model)) return;
	if (!isTransportAwareApiSupported(model.api)) throw new Error(`Model-provider request.proxy/request.tls/localService is not yet supported for api "${model.api}"`);
	return createSupportedTransportStreamFn(model, ctx);
}
function createBoundaryAwareStreamFnForModel(model, ctx) {
	if (!isTransportAwareApiSupported(model.api)) return;
	return createSupportedTransportStreamFn(model, ctx);
}
function prepareTransportAwareSimpleModel(model, ctx) {
	const streamFn = createTransportAwareStreamFnForModel(model, ctx);
	const alias = resolveTransportAwareSimpleApi(model.api);
	if (!streamFn || !alias) return model;
	return {
		...model,
		api: alias
	};
}
function buildTransportAwareSimpleStreamFn(model, ctx) {
	return createTransportAwareStreamFnForModel(model, ctx);
}
//#endregion
//#region src/agents/provider-stream.ts
function registerProviderStreamForModel(params) {
	const streamFn = resolveProviderStreamFn({
		provider: params.model.provider,
		config: params.cfg,
		workspaceDir: params.workspaceDir,
		env: params.env,
		allowRuntimePluginLoad: params.allowRuntimePluginLoad,
		context: {
			config: params.cfg,
			agentDir: params.agentDir,
			workspaceDir: params.workspaceDir,
			provider: params.model.provider,
			modelId: params.model.id,
			model: params.model
		}
	}) ?? createTransportAwareStreamFnForModel(params.model, {
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	if (!streamFn) return;
	ensureCustomApiRegistered(params.model.api, streamFn);
	return streamFn;
}
//#endregion
export { ensureCustomApiRegistered as a, prepareTransportAwareSimpleModel as i, buildTransportAwareSimpleStreamFn as n, createBoundaryAwareStreamFnForModel as r, registerProviderStreamForModel as t };
