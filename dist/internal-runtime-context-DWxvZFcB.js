//#region src/agents/internal-runtime-context.ts
const INTERNAL_RUNTIME_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_RUNTIME_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const ESCAPED_INTERNAL_RUNTIME_CONTEXT_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";
const OPENCLAW_RUNTIME_CONTEXT_NOTICE = "This context is runtime-generated, not user-authored. Keep internal details private.";
const OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER = "OpenClaw runtime context for the immediately preceding user message.";
const OPENCLAW_RUNTIME_EVENT_HEADER = "OpenClaw runtime event.";
const OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE = "openclaw.runtime-context";
const LEGACY_INTERNAL_CONTEXT_HEADER = [
	"OpenClaw runtime context (internal):",
	OPENCLAW_RUNTIME_CONTEXT_NOTICE,
	""
].join("\n") + "\n";
const LEGACY_INTERNAL_EVENT_MARKER = "[Internal task completion event]";
const LEGACY_INTERNAL_EVENT_SEPARATOR = "\n\n---\n\n";
const LEGACY_UNTRUSTED_RESULT_BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const LEGACY_UNTRUSTED_RESULT_END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";
function escapeInternalRuntimeContextDelimiters(value) {
	return value.replaceAll(INTERNAL_RUNTIME_CONTEXT_BEGIN, ESCAPED_INTERNAL_RUNTIME_CONTEXT_BEGIN).replaceAll(INTERNAL_RUNTIME_CONTEXT_END, ESCAPED_INTERNAL_RUNTIME_CONTEXT_END);
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findDelimitedTokenIndex(text, token, from) {
	const tokenRe = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(token)}(?=\\r?\\n|$)`, "g");
	tokenRe.lastIndex = Math.max(0, from);
	const match = tokenRe.exec(text);
	if (!match) return -1;
	const prefixLength = match[0].length - token.length;
	return match.index + prefixLength;
}
function stripDelimitedBlock(text, begin, end) {
	let next = text;
	for (;;) {
		const start = findDelimitedTokenIndex(next, begin, 0);
		if (start === -1) return next;
		let cursor = start + begin.length;
		let depth = 1;
		let finish = -1;
		while (depth > 0) {
			const nextBegin = findDelimitedTokenIndex(next, begin, cursor);
			const nextEnd = findDelimitedTokenIndex(next, end, cursor);
			if (nextEnd === -1) break;
			if (nextBegin !== -1 && nextBegin < nextEnd) {
				depth += 1;
				cursor = nextBegin + begin.length;
				continue;
			}
			depth -= 1;
			finish = nextEnd;
			cursor = nextEnd + end.length;
		}
		const before = next.slice(0, start).trimEnd();
		if (finish === -1 || depth !== 0) return before;
		const after = next.slice(finish + end.length).trimStart();
		next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
	}
}
function findLegacyInternalEventEnd(text, start) {
	if (!text.startsWith(LEGACY_INTERNAL_EVENT_MARKER, start)) return null;
	const resultBegin = text.indexOf(LEGACY_UNTRUSTED_RESULT_BEGIN, start + 32);
	if (resultBegin === -1) return null;
	const resultEnd = text.indexOf(LEGACY_UNTRUSTED_RESULT_END, resultBegin + 34);
	if (resultEnd === -1) return null;
	const actionIndex = text.indexOf("\n\nAction:\n", resultEnd + 32);
	if (actionIndex === -1) return null;
	const afterAction = actionIndex + 10;
	const nextEvent = text.indexOf(`${LEGACY_INTERNAL_EVENT_SEPARATOR}${LEGACY_INTERNAL_EVENT_MARKER}`, afterAction);
	if (nextEvent !== -1) return nextEvent;
	const nextParagraph = text.indexOf("\n\n", afterAction);
	return nextParagraph === -1 ? text.length : nextParagraph;
}
function stripLegacyInternalRuntimeContext(text) {
	let next = text;
	let searchFrom = 0;
	for (;;) {
		const headerStart = next.indexOf(LEGACY_INTERNAL_CONTEXT_HEADER, searchFrom);
		if (headerStart === -1) return next;
		const eventStart = headerStart + LEGACY_INTERNAL_CONTEXT_HEADER.length;
		if (!next.startsWith(LEGACY_INTERNAL_EVENT_MARKER, eventStart)) {
			searchFrom = eventStart;
			continue;
		}
		let blockEnd = findLegacyInternalEventEnd(next, eventStart);
		if (blockEnd == null) {
			const nextParagraph = next.indexOf("\n\n", eventStart + 32);
			blockEnd = nextParagraph === -1 ? next.length : nextParagraph;
		} else while (next.startsWith(`${LEGACY_INTERNAL_EVENT_SEPARATOR}${LEGACY_INTERNAL_EVENT_MARKER}`, blockEnd)) {
			const nextEventStart = blockEnd + 7;
			const nextEventEnd = findLegacyInternalEventEnd(next, nextEventStart);
			if (nextEventEnd == null) break;
			blockEnd = nextEventEnd;
		}
		const before = next.slice(0, headerStart).trimEnd();
		const after = next.slice(blockEnd).trimStart();
		next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
		searchFrom = Math.max(0, before.length - 1);
	}
}
function isRuntimeContextPromptHeader(line) {
	return line === "OpenClaw runtime context for the immediately preceding user message." || line === "OpenClaw runtime event.";
}
function stripRuntimeContextPromptPreface(text) {
	const lines = text.split(/\r?\n/);
	let changed = false;
	const output = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const nextLine = lines[index + 1] ?? "";
		if (isRuntimeContextPromptHeader(line.trim()) && nextLine.trim() === "This context is runtime-generated, not user-authored. Keep internal details private.") {
			changed = true;
			index += 1;
			while (index + 1 < lines.length && (lines[index + 1] ?? "").trim() === "") index += 1;
			continue;
		}
		output.push(line);
	}
	return changed ? output.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
}
function stripInternalRuntimeContext(text) {
	if (!text) return text;
	return stripRuntimeContextPromptPreface(stripLegacyInternalRuntimeContext(stripDelimitedBlock(text, INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END)));
}
function hasInternalRuntimeContext(text) {
	if (!text) return false;
	return findDelimitedTokenIndex(text, "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", 0) !== -1 || text.includes(LEGACY_INTERNAL_CONTEXT_HEADER) || text.includes(`OpenClaw runtime context for the immediately preceding user message.\nThis context is runtime-generated, not user-authored. Keep internal details private.`) || text.includes(`OpenClaw runtime event.\nThis context is runtime-generated, not user-authored. Keep internal details private.`);
}
function isOpenClawRuntimeContextCustomMessage(message) {
	if (!message || typeof message !== "object") return false;
	const candidate = message;
	return candidate.role === "custom" && candidate.customType === "openclaw.runtime-context";
}
function stripRuntimeContextCustomMessages(messages) {
	if (!messages.some(isOpenClawRuntimeContextCustomMessage)) return messages;
	return messages.filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
}
function isUserMessage(message) {
	return Boolean(message && typeof message === "object" && message.role === "user");
}
/** Removes stale runtime-context custom messages while preserving current-turn context. */
function stripHistoricalRuntimeContextCustomMessages(messages) {
	if (!messages.some(isOpenClawRuntimeContextCustomMessage)) return messages;
	const lastUserIndex = messages.findLastIndex(isUserMessage);
	if (lastUserIndex === -1) return messages.filter((message) => !isOpenClawRuntimeContextCustomMessage(message));
	return messages.filter((message, index) => !isOpenClawRuntimeContextCustomMessage(message) || index > lastUserIndex);
}
//#endregion
export { OPENCLAW_RUNTIME_CONTEXT_NOTICE as a, hasInternalRuntimeContext as c, stripRuntimeContextCustomMessages as d, OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE as i, stripHistoricalRuntimeContextCustomMessages as l, INTERNAL_RUNTIME_CONTEXT_END as n, OPENCLAW_RUNTIME_EVENT_HEADER as o, OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER as r, escapeInternalRuntimeContextDelimiters as s, INTERNAL_RUNTIME_CONTEXT_BEGIN as t, stripInternalRuntimeContext as u };
