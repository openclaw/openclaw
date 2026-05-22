import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { _ as transformTransportMessages, c as coerceTransportToolCallArguments, d as failTransportStream, f as finalizeTransportStream, g as sanitizeTransportPayloadText, l as createEmptyTransportUsage, p as mergeTransportHeaders, u as createWritableTransportEventStream, v as buildGuardedModelFetch } from "./openai-transport-stream-CdzrQU5-.js";
import { i as stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary-CVh6mizX.js";
import { a as createProviderHttpError } from "./provider-http-errors-PJfipwb1.js";
import { d as isGoogleGemini3FlashModel, f as isGoogleGemini3ProModel, g as resolveGoogleGemini3ThinkingLevel, u as isGoogleGemini25ThinkingBudgetModel, v as stripInvalidGoogleThinkingBudget } from "./provider-stream-shared-CniO1vxU.js";
import "./text-runtime-FOsx_CPC.js";
import "./provider-http-CsEZxABD.js";
import "./provider-transport-runtime-BHZs1OKL.js";
import "./thinking-api-BmaNvGWB.js";
import { r as normalizeGoogleApiBaseUrl } from "./provider-policy-CjI20mAk.js";
import { t as parseGeminiAuth } from "./gemini-auth-sjpOYDxC.js";
import { i as resolveGoogleVertexAuthorizedUserHeaders, n as isGoogleVertexCredentialsMarker } from "./vertex-adc-CDmk77Ox.js";
import { calculateCost, getEnvApiKey } from "@mariozechner/pi-ai";
//#region extensions/google/transport-stream.ts
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
	const transformedMessages = transformTransportMessages(context.messages, model, (id) => requiresToolCallId(model.id) ? normalizeToolCallId(id) : id, { preserveCrossModelToolCallThoughtSignature: requiresToolCallThoughtSignature(model.id) });
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
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
			const parts = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (!block.text.trim()) continue;
					parts.push({
						text: sanitizeTransportPayloadText(block.text),
						...isSameProviderAndModel && block.textSignature ? { thoughtSignature: block.textSignature } : {}
					});
					continue;
				}
				if (block.type === "thinking") {
					if (!block.thinking.trim()) continue;
					if (isSameProviderAndModel) parts.push({
						thought: true,
						text: sanitizeTransportPayloadText(block.thinking),
						...block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}
					});
					else parts.push({ text: sanitizeTransportPayloadText(block.thinking) });
					continue;
				}
				if (block.type === "toolCall") {
					const thoughtSignature = (isSameProviderAndModel ? block.thoughtSignature : void 0) ?? (requiresToolCallThoughtSignature(model.id) ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP : void 0);
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
				yield JSON.parse(data);
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
				const response = await guardedFetch(buildGoogleTransportRequestUrl(kind, model, options), {
					method: "POST",
					headers: await buildGoogleTransportHeaders({
						kind,
						model,
						apiKey,
						optionHeaders: options?.headers,
						fetchImpl: options?.fetch
					}),
					body: JSON.stringify(params),
					signal: options?.signal
				});
				if (!response.ok) throw await createProviderHttpError(response, kind === "google-vertex" ? "Google Vertex AI API error" : "Google Generative AI API error");
				stream.push({
					type: "start",
					partial: output
				});
				let currentBlockIndex = -1;
				for await (const chunk of parseGoogleSseChunks(response, options?.signal)) {
					output.responseId ||= chunk.responseId;
					updateUsage(output, model, chunk);
					const candidate = chunk.candidates?.[0];
					if (candidate?.content?.parts) for (const part of candidate.content.parts) {
						const hasThoughtSignature = typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
						const hasText = typeof part.text === "string";
						if (hasText || hasThoughtSignature && !part.functionCall) {
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
							const toolCall = {
								type: "toolCall",
								id: providedId && !isDuplicate ? providedId : `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`,
								name: part.functionCall.name || "",
								arguments: part.functionCall.args ?? {},
								thoughtSignature: part.thoughtSignature
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
export { createGoogleGenerativeAiTransportStreamFn as n, createGoogleVertexTransportStreamFn as r, buildGoogleGenerativeAiParams as t };
