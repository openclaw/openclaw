import { u as stripHeartbeatToken } from "./heartbeat-DJ4ZZ8Yg.js";
//#region src/auto-reply/heartbeat-filter.ts
const HEARTBEAT_TASK_PROMPT_PREFIX = "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_ACK = "After completing all due tasks, reply HEARTBEAT_OK.";
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
		if (block.type !== "text") {
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
	if (normalizedHeartbeatPrompt && trimmed.startsWith(normalizedHeartbeatPrompt)) return true;
	return trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) && trimmed.includes(HEARTBEAT_TASK_PROMPT_ACK);
}
function isHeartbeatOkResponse(message, ackMaxChars) {
	if (message.role !== "assistant") return false;
	const { text, hasNonTextContent } = resolveMessageText(message.content);
	if (hasNonTextContent) return false;
	return stripHeartbeatToken(text, {
		mode: "heartbeat",
		maxAckChars: ackMaxChars
	}).shouldSkip;
}
function filterHeartbeatPairs(messages, ackMaxChars, heartbeatPrompt) {
	if (messages.length < 2) return messages;
	const result = [];
	let i = 0;
	while (i < messages.length) {
		if (i + 1 < messages.length && isHeartbeatUserMessage(messages[i], heartbeatPrompt) && isHeartbeatOkResponse(messages[i + 1], ackMaxChars)) {
			i += 2;
			continue;
		}
		result.push(messages[i]);
		i++;
	}
	return result;
}
//#endregion
export { isHeartbeatOkResponse as n, isHeartbeatUserMessage as r, filterHeartbeatPairs as t };
