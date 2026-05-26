import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import "./provider-stream-shared-jI_a6bxx.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { streamSimple } from "@earendil-works/pi-ai";
//#region extensions/kimi-coding/stream.ts
const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";
const KIMI_ANTHROPIC_THINKING_BUDGETS = {
	minimal: 1024,
	low: 1024,
	medium: 4096,
	high: 8192,
	adaptive: 8192,
	xhigh: 8192,
	max: 8192
};
const KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS = 1024;
const KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS = 16e3;
function normalizeKimiThinkingBudgetTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const normalized = Math.floor(value);
	return normalized >= 1024 ? normalized : void 0;
}
function normalizeKimiAnthropicMaxTokens(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : void 0;
}
function ensureKimiAnthropicMaxTokens(payloadObj, thinkingConfig) {
	if (thinkingConfig.type !== "enabled" || thinkingConfig.budget_tokens === void 0) return;
	const required = Math.max(KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS, thinkingConfig.budget_tokens + KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS);
	const current = normalizeKimiAnthropicMaxTokens(payloadObj.max_tokens);
	payloadObj.max_tokens = current === void 0 ? required : Math.max(current, required);
}
function messageHasOpenAIToolCalls(message) {
	return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}
function ensureKimiOpenAIReasoningContent(payloadObj) {
	if (!Array.isArray(payloadObj.messages)) return;
	for (const message of payloadObj.messages) {
		if (!message || typeof message !== "object") continue;
		const record = message;
		if (record.role !== "assistant" || !messageHasOpenAIToolCalls(record)) continue;
		if (!("reasoning_content" in record)) record.reasoning_content = "";
	}
}
function stripKimiOpenAIReasoningContent(payloadObj) {
	if (!Array.isArray(payloadObj.messages)) return;
	for (const message of payloadObj.messages) if (message && typeof message === "object") delete message.reasoning_content;
}
function normalizeKimiThinkingType(value) {
	if (typeof value === "boolean") return value ? "enabled" : "disabled";
	if (typeof value === "string") {
		const normalized = normalizeOptionalLowercaseString(value);
		if (!normalized) return;
		if ([
			"enabled",
			"enable",
			"on",
			"true"
		].includes(normalized)) return "enabled";
		if ([
			"disabled",
			"disable",
			"off",
			"false"
		].includes(normalized)) return "disabled";
		return;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) return normalizeKimiThinkingType(value.type);
}
function normalizeKimiThinkingConfig(value) {
	const type = normalizeKimiThinkingType(value);
	if (!type) return;
	if (type === "disabled") return { type: "disabled" };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "enabled" };
	const record = value;
	const budgetTokens = normalizeKimiThinkingBudgetTokens(record.budget_tokens ?? record.budgetTokens);
	return budgetTokens === void 0 ? { type: "enabled" } : {
		type: "enabled",
		budget_tokens: budgetTokens
	};
}
function resolveKimiAnthropicThinkingBudgetTokens(thinkingLevel) {
	if (!thinkingLevel || thinkingLevel === "off") return;
	return KIMI_ANTHROPIC_THINKING_BUDGETS[thinkingLevel];
}
function resolveKimiThinkingConfig(params) {
	const configured = normalizeKimiThinkingConfig(params.configuredThinking);
	const levelBudgetTokens = resolveKimiAnthropicThinkingBudgetTokens(params.thinkingLevel);
	if (configured) return configured.type === "enabled" && configured.budget_tokens === void 0 ? {
		type: "enabled",
		budget_tokens: levelBudgetTokens ?? 1024
	} : configured;
	if (!params.thinkingLevel || params.thinkingLevel === "off") return { type: "disabled" };
	return levelBudgetTokens === void 0 ? { type: "enabled" } : {
		type: "enabled",
		budget_tokens: levelBudgetTokens
	};
}
function resolveKimiThinkingType(params) {
	return resolveKimiThinkingConfig(params).type;
}
function stripTaggedToolCallCounter(value) {
	return value.trim().replace(/:\d+$/, "");
}
function parseKimiTaggedToolCalls(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith(TOOL_CALLS_SECTION_BEGIN) || !trimmed.endsWith(TOOL_CALLS_SECTION_END)) return null;
	let cursor = 28;
	const sectionEndIndex = trimmed.length - 26;
	const toolCalls = [];
	while (cursor < sectionEndIndex) {
		while (cursor < sectionEndIndex && /\s/.test(trimmed[cursor] ?? "")) cursor += 1;
		if (cursor >= sectionEndIndex) break;
		if (!trimmed.startsWith(TOOL_CALL_BEGIN, cursor)) return null;
		const nameStart = cursor + 19;
		const argMarkerIndex = trimmed.indexOf(TOOL_CALL_ARGUMENT_BEGIN, nameStart);
		if (argMarkerIndex < 0 || argMarkerIndex >= sectionEndIndex) return null;
		const rawId = trimmed.slice(nameStart, argMarkerIndex).trim();
		if (!rawId) return null;
		const argsStart = argMarkerIndex + 28;
		const callEndIndex = trimmed.indexOf(TOOL_CALL_END, argsStart);
		if (callEndIndex < 0 || callEndIndex > sectionEndIndex) return null;
		const rawArgs = trimmed.slice(argsStart, callEndIndex).trim();
		let parsedArgs;
		try {
			parsedArgs = JSON.parse(rawArgs);
		} catch {
			return null;
		}
		if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) return null;
		const name = stripTaggedToolCallCounter(rawId);
		if (!name) return null;
		toolCalls.push({
			type: "toolCall",
			id: rawId,
			name,
			arguments: parsedArgs
		});
		cursor = callEndIndex + 17;
	}
	return toolCalls.length > 0 ? toolCalls : null;
}
function rewriteKimiTaggedToolCallsInMessage(message) {
	if (!message || typeof message !== "object") return;
	const content = message.content;
	if (!Array.isArray(content)) return;
	let changed = false;
	const nextContent = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			nextContent.push(block);
			continue;
		}
		const typedBlock = block;
		if (typedBlock.type !== "text" || typeof typedBlock.text !== "string") {
			nextContent.push(block);
			continue;
		}
		const parsed = parseKimiTaggedToolCalls(typedBlock.text);
		if (!parsed) {
			nextContent.push(block);
			continue;
		}
		nextContent.push(...parsed);
		changed = true;
	}
	if (!changed) return;
	message.content = nextContent;
	const typedMessage = message;
	if (typedMessage.stopReason === "stop") typedMessage.stopReason = "toolUse";
}
function transformKimiStreamEvent(value, transformMessage) {
	const event = value && typeof value === "object" ? value : void 0;
	if (!event) return;
	for (const message of [event.partial, event.message]) transformMessage(message);
}
function wrapStreamMessageObjects(stream, transformMessage) {
	const readFinalMessage = stream.result.bind(stream);
	Object.assign(stream, { async result() {
		const message = await readFinalMessage();
		transformMessage(message);
		return message;
	} });
	const createIterator = stream[Symbol.asyncIterator].bind(stream);
	stream[Symbol.asyncIterator] = () => {
		const iterator = createIterator();
		return {
			async next() {
				const step = await iterator.next();
				if (!step.done) transformKimiStreamEvent(step.value, transformMessage);
				return step;
			},
			async return(value) {
				return iterator.return?.(value) ?? {
					done: true,
					value: void 0
				};
			},
			async throw(error) {
				return iterator.throw?.(error) ?? {
					done: true,
					value: void 0
				};
			}
		};
	};
	return stream;
}
function createKimiToolCallMarkupWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const maybeStream = underlying(model, context, options);
		if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) return Promise.resolve(maybeStream).then((stream) => wrapStreamMessageObjects(stream, rewriteKimiTaggedToolCallsInMessage));
		return wrapStreamMessageObjects(maybeStream, rewriteKimiTaggedToolCallsInMessage);
	};
}
function createKimiThinkingWrapper(baseStreamFn, thinkingConfig) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
		const normalized = typeof thinkingConfig === "string" ? { type: thinkingConfig } : thinkingConfig;
		payloadObj.thinking = model.api === "anthropic-messages" ? { ...normalized } : { type: normalized.type };
		if (model.api === "anthropic-messages") ensureKimiAnthropicMaxTokens(payloadObj, normalized);
		else if (normalized.type === "enabled") ensureKimiOpenAIReasoningContent(payloadObj);
		else stripKimiOpenAIReasoningContent(payloadObj);
		delete payloadObj.reasoning;
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
	});
}
function wrapKimiProviderStream(ctx) {
	const thinkingConfig = resolveKimiThinkingConfig({
		configuredThinking: ctx.extraParams?.thinking,
		thinkingLevel: ctx.thinkingLevel
	});
	return createKimiToolCallMarkupWrapper(createKimiThinkingWrapper(ctx.streamFn, thinkingConfig));
}
//#endregion
export { wrapKimiProviderStream as a, resolveKimiThinkingType as i, createKimiToolCallMarkupWrapper as n, resolveKimiThinkingConfig as r, createKimiThinkingWrapper as t };
