import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { g as streamWithPayloadPatch } from "./provider-model-shared-BJrHvRZi.js";
import { x as wrapStreamMessageObjects } from "./provider-stream-shared-CN5xC3-5.js";
import "./text-runtime-CEUy8PW0.js";
import { streamSimple } from "@mariozechner/pi-ai";
//#region extensions/kimi-coding/stream.ts
const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";
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
function resolveKimiThinkingType(params) {
	const configured = normalizeKimiThinkingType(params.configuredThinking);
	if (configured) return configured;
	if (!params.thinkingLevel || params.thinkingLevel === "off") return "disabled";
	return "enabled";
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
function createKimiToolCallMarkupWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const maybeStream = underlying(model, context, options);
		if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) return Promise.resolve(maybeStream).then((stream) => wrapStreamMessageObjects(stream, rewriteKimiTaggedToolCallsInMessage));
		return wrapStreamMessageObjects(maybeStream, rewriteKimiTaggedToolCallsInMessage);
	};
}
function createKimiThinkingWrapper(baseStreamFn, thinkingType) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
		payloadObj.thinking = { type: thinkingType };
		delete payloadObj.reasoning;
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
	});
}
function wrapKimiProviderStream(ctx) {
	const thinkingType = resolveKimiThinkingType({
		configuredThinking: ctx.extraParams?.thinking,
		thinkingLevel: ctx.thinkingLevel
	});
	return createKimiToolCallMarkupWrapper(createKimiThinkingWrapper(ctx.streamFn, thinkingType));
}
//#endregion
export { wrapKimiProviderStream as i, createKimiToolCallMarkupWrapper as n, resolveKimiThinkingType as r, createKimiThinkingWrapper as t };
