import "./heartbeat-tool-response-Cf_D5Tj1.js";
import { d as stripHeartbeatToken, i as HEARTBEAT_RESPONSE_TOOL_PROMPT, u as resolveHeartbeatPromptForResponseTool } from "./heartbeat-6oYmHVVQ.js";
//#region src/auto-reply/heartbeat-filter.ts
const HEARTBEAT_TASK_PROMPT_PREFIX = "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_ACK = "After completing all due tasks, reply HEARTBEAT_OK.";
const TOOL_CALL_BLOCK_TYPES = new Set([
	"toolCall",
	"functionCall",
	"toolUse",
	"tool_call",
	"function_call",
	"tool_use"
]);
const TOOL_RESULT_BLOCK_TYPES = new Set([
	"toolResult",
	"tool_result",
	"tool_result_error",
	"function_call_output"
]);
const MESSAGE_TOOL_DELIVERY_PREFIX = "Delivery: to send a message, use the `message` tool.";
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readNestedString(record, key) {
	const value = record[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	if (!isRecord(value)) return;
	return readString(value.name);
}
function collectToolCallBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => isRecord(block) && TOOL_CALL_BLOCK_TYPES.has(readString(block.type) ?? ""));
}
function collectToolResultBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => isRecord(block) && TOOL_RESULT_BLOCK_TYPES.has(readString(block.type) ?? ""));
}
function readToolCallName(block) {
	return readString(block.name) ?? readNestedString(block, "function");
}
function collectToolCallIds(block) {
	const ids = [
		readString(block.call_id),
		readString(block.tool_call_id),
		readString(block.toolCallId),
		readString(block.tool_use_id),
		readString(block.toolUseId),
		readString(block.id)
	].filter((id) => Boolean(id));
	return [...new Set(ids)];
}
function readNestedToolCallArguments(record) {
	const value = record.function;
	if (!isRecord(value)) return;
	return value.arguments ?? value.args ?? value.input;
}
function readToolCallArguments(block) {
	return block.arguments ?? block.args ?? block.input ?? readNestedToolCallArguments(block);
}
function parseToolCallArguments(value) {
	if (isRecord(value)) return value;
	if (typeof value !== "string" || !value.trim()) return;
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function isVisibleHeartbeatResponseToolCall(block) {
	const args = parseToolCallArguments(readToolCallArguments(block));
	if (!args) return false;
	return args.notify === true || args.notify === "true";
}
function collectVisibleHeartbeatResponseToolCalls(message) {
	if (message.role !== "assistant") return [];
	return [...collectMessageToolCalls(message), ...collectToolCallBlocks(message.content)].filter((block) => readToolCallName(block) === "heartbeat_respond" && isVisibleHeartbeatResponseToolCall(block));
}
function collectMessageToolCalls(message) {
	const toolCalls = message.tool_calls;
	if (!Array.isArray(toolCalls)) return [];
	return toolCalls.filter((call) => isRecord(call));
}
function hasAssistantToolCall(message) {
	return message.role === "assistant" && (collectMessageToolCalls(message).length > 0 || collectToolCallBlocks(message.content).length > 0);
}
function isRemovableHeartbeatResponseToolCall(message) {
	if (message.role !== "assistant") return false;
	for (const call of collectMessageToolCalls(message)) if (readToolCallName(call) === "heartbeat_respond" && !isVisibleHeartbeatResponseToolCall(call)) return true;
	return collectToolCallBlocks(message.content).some((block) => readToolCallName(block) === "heartbeat_respond" && !isVisibleHeartbeatResponseToolCall(block));
}
function hasVisibleHeartbeatResponseToolCall(message) {
	return collectVisibleHeartbeatResponseToolCalls(message).length > 0;
}
function isEmbeddedToolResultOnlyContent(content) {
	return Array.isArray(content) && content.length > 0 && content.every((block) => isRecord(block) && TOOL_RESULT_BLOCK_TYPES.has(readString(block.type) ?? ""));
}
function isToolResultMessage(message) {
	return message.role === "toolResult" || message.role === "tool" || message.role === "user" && isEmbeddedToolResultOnlyContent(message.content);
}
function isFailedToolResultRecord(record) {
	return record.isError === true || record.is_error === true || readString(record.type) === "tool_result_error";
}
function hasSuccessfulToolResultMessage(message) {
	const resultBlocks = collectToolResultBlocks(message.content);
	if (resultBlocks.length > 0) return resultBlocks.some((block) => !isFailedToolResultRecord(block));
	if (!isToolResultMessage(message)) return false;
	return !isFailedToolResultRecord(message);
}
function collectSuccessfulToolResultCallIds(message) {
	const record = message;
	const resultBlocks = collectToolResultBlocks(message.content);
	const ids = [];
	if (resultBlocks.length === 0) {
		if (!isFailedToolResultRecord(record)) ids.push(...[
			readString(record.toolCallId),
			readString(record.tool_call_id),
			readString(record.toolUseId),
			readString(record.tool_use_id),
			readString(record.call_id),
			readString(record.id)
		].filter((id) => Boolean(id)));
	} else for (const block of resultBlocks) {
		if (isFailedToolResultRecord(block)) continue;
		ids.push(...collectToolCallIds(block));
	}
	return [...new Set(ids)];
}
function isRealNonHeartbeatUserMessage(message, heartbeatPrompt) {
	return message.role === "user" && !isEmbeddedToolResultOnlyContent(message.content) && !isHeartbeatUserMessage(message, heartbeatPrompt);
}
function matchesHeartbeatPromptText(text, prompt) {
	const normalized = prompt?.trim();
	return Boolean(normalized) && (text === normalized || text.startsWith(`${normalized}\n`));
}
function resolveMessageText(content) {
	if (typeof content === "string") return {
		text: content,
		hasNonTextContent: false
	};
	if (!Array.isArray(content)) return {
		text: "",
		hasNonTextContent: content != null
	};
	let hasNonTextContent = false;
	let text = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null || !("type" in block)) {
			hasNonTextContent = true;
			continue;
		}
		if (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text") {
			hasNonTextContent = true;
			continue;
		}
		const blockText = block.text;
		if (typeof blockText !== "string") {
			hasNonTextContent = true;
			continue;
		}
		text += blockText;
	}
	return {
		text,
		hasNonTextContent
	};
}
function isHeartbeatUserMessage(message, heartbeatPrompt) {
	if (message.role !== "user") return false;
	const { text } = resolveMessageText(message.content);
	const trimmed = text.trim();
	if (!trimmed) return false;
	const normalizedHeartbeatPrompt = heartbeatPrompt?.trim();
	if (trimmed === "[OpenClaw heartbeat poll]") return true;
	if (trimmed.startsWith(MESSAGE_TOOL_DELIVERY_PREFIX) && trimmed.endsWith("[OpenClaw heartbeat poll]")) return true;
	if (matchesHeartbeatPromptText(trimmed, normalizedHeartbeatPrompt)) return true;
	if (matchesHeartbeatPromptText(trimmed, HEARTBEAT_RESPONSE_TOOL_PROMPT)) return true;
	if (normalizedHeartbeatPrompt && matchesHeartbeatPromptText(trimmed, resolveHeartbeatPromptForResponseTool(normalizedHeartbeatPrompt))) return true;
	return trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) && trimmed.includes(HEARTBEAT_TASK_PROMPT_ACK);
}
function isHeartbeatOkResponse(message, ackMaxChars) {
	if (message.role !== "assistant") return false;
	if (hasAssistantToolCall(message)) return false;
	const { text, hasNonTextContent } = resolveMessageText(message.content);
	if (hasNonTextContent) return false;
	return stripHeartbeatToken(text, {
		mode: "heartbeat",
		maxAckChars: ackMaxChars
	}).shouldSkip;
}
function advancePastAdjacentToolResults(messages, startIndex) {
	let index = startIndex;
	while (index < messages.length && isToolResultMessage(messages[index])) index++;
	return index;
}
function isToolResultCompletionCandidate(message) {
	return isToolResultMessage(message) || collectToolResultBlocks(message.content).length > 0;
}
function hasCompletedVisibleHeartbeatResponseToolCall(messages, index) {
	const visibleCalls = collectVisibleHeartbeatResponseToolCalls(messages[index]);
	if (visibleCalls.length === 0) return false;
	const callIds = new Set(visibleCalls.flatMap((call) => collectToolCallIds(call)));
	for (let resultIndex = index + 1; resultIndex < messages.length && isToolResultCompletionCandidate(messages[resultIndex]); resultIndex++) {
		const result = messages[resultIndex];
		if (!hasSuccessfulToolResultMessage(result)) continue;
		if (callIds.size === 0) return true;
		for (const resultId of collectSuccessfulToolResultCallIds(result)) if (callIds.has(resultId)) return true;
	}
	return false;
}
function resolveHeartbeatArtifactSpanEnd(messages, startIndex, ackMaxChars, heartbeatPrompt) {
	let index = startIndex + 1;
	let sawTerminalHeartbeatArtifact = false;
	let sawNonTerminalAssistantOutput = false;
	while (index < messages.length) {
		const message = messages[index];
		if (isRealNonHeartbeatUserMessage(message, heartbeatPrompt)) break;
		if (isHeartbeatUserMessage(message, heartbeatPrompt)) break;
		if (isHeartbeatOkResponse(message, ackMaxChars)) {
			sawTerminalHeartbeatArtifact = true;
			index = advancePastAdjacentToolResults(messages, index + 1);
			continue;
		}
		if (hasVisibleHeartbeatResponseToolCall(message)) {
			if (hasCompletedVisibleHeartbeatResponseToolCall(messages, index)) return;
			index++;
			continue;
		}
		if (isRemovableHeartbeatResponseToolCall(message)) {
			sawTerminalHeartbeatArtifact = true;
			index = advancePastAdjacentToolResults(messages, index + 1);
			continue;
		}
		if (sawTerminalHeartbeatArtifact) {
			index++;
			continue;
		}
		if (isToolResultMessage(message) || hasAssistantToolCall(message)) {
			index++;
			continue;
		}
		if (message.role === "assistant") {
			sawNonTerminalAssistantOutput = true;
			index++;
			continue;
		}
		return;
	}
	if (sawNonTerminalAssistantOutput && !sawTerminalHeartbeatArtifact) return;
	return index;
}
function filterHeartbeatTranscriptArtifacts(messages, ackMaxChars, heartbeatPrompt) {
	if (messages.length === 0) return messages;
	const result = [];
	let i = 0;
	while (i < messages.length) {
		if (!isHeartbeatUserMessage(messages[i], heartbeatPrompt)) {
			result.push(messages[i]);
			i++;
			continue;
		}
		const next = resolveHeartbeatArtifactSpanEnd(messages, i, ackMaxChars, heartbeatPrompt);
		if (next === void 0) {
			result.push(messages[i]);
			i++;
			continue;
		}
		i = next;
	}
	return result;
}
//#endregion
export { isHeartbeatOkResponse as n, isHeartbeatUserMessage as r, filterHeartbeatTranscriptArtifacts as t };
