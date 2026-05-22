//#region extensions/opencode-go/reasoning-sanitizer.ts
const REASONING_REPLAY_FIELDS = [
	"reasoning_details",
	"reasoning_content",
	"reasoning",
	"reasoning_text"
];
const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";
function isReasoningReplayPart(value) {
	if (!value || typeof value !== "object") return false;
	const type = value.type;
	return type === "thinking" || type === "redacted_thinking" || type === "reasoning";
}
function stripReasoningReplayFields(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	for (const field of REASONING_REPLAY_FIELDS) delete record[field];
	const content = record.content;
	if (Array.isArray(content)) {
		const nextContent = [];
		for (const part of content) {
			if (isReasoningReplayPart(part)) continue;
			stripReasoningReplayFields(part);
			nextContent.push(part);
		}
		record.content = nextContent.length > 0 ? nextContent : [{
			type: "text",
			text: OMITTED_ASSISTANT_REASONING_TEXT
		}];
	}
}
function stripReasoningReplayFieldsFromList(value) {
	if (!Array.isArray(value)) return value;
	const nextItems = [];
	for (const item of value) {
		if (isReasoningReplayPart(item)) continue;
		stripReasoningReplayFields(item);
		nextItems.push(item);
	}
	return nextItems;
}
function stripOpencodeGoKimiReasoningPayload(payloadObj) {
	stripReasoningReplayFields(payloadObj);
	delete payloadObj.reasoning_effort;
	delete payloadObj.reasoningEffort;
	if ("messages" in payloadObj) payloadObj.messages = stripReasoningReplayFieldsFromList(payloadObj.messages);
	if ("input" in payloadObj) payloadObj.input = stripReasoningReplayFieldsFromList(payloadObj.input);
}
//#endregion
export { stripOpencodeGoKimiReasoningPayload as t };
