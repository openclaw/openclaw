//#region src/plugin-sdk/tool-payload.ts
function isToolPayloadTextBlock(block) {
	return !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
}
/**
* Extract the most useful payload from tool result-like objects shared across
* outbound core flows and bundled plugin helpers.
*/
function extractToolPayload(result) {
	if (!result) return;
	if (result.details !== void 0) return result.details;
	const text = (Array.isArray(result.content) ? result.content.find(isToolPayloadTextBlock) : void 0)?.text;
	if (!text) return result.content ?? result;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256e3;
const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
function isToolNameChar(char) {
	return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}
function skipHorizontalWhitespace(text, start) {
	let index = start;
	while (index < text.length && (text[index] === " " || text[index] === "	")) index += 1;
	return index;
}
function skipWhitespace(text, start) {
	let index = start;
	while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
	return index;
}
function consumeLineBreak(text, start) {
	if (text[start] === "\r") return text[start + 1] === "\n" ? start + 2 : start + 1;
	if (text[start] === "\n") return start + 1;
	return null;
}
function parseOpening(text, start) {
	if (text[start] !== "[") return null;
	let cursor = start + 1;
	const nameStart = cursor;
	while (isToolNameChar(text[cursor])) cursor += 1;
	if (cursor === nameStart || text[cursor] !== "]") return null;
	const name = text.slice(nameStart, cursor);
	cursor += 1;
	cursor = skipHorizontalWhitespace(text, cursor);
	const afterLineBreak = consumeLineBreak(text, cursor);
	if (afterLineBreak === null) return null;
	return {
		end: afterLineBreak,
		name
	};
}
function consumeJsonObject(text, start, maxPayloadBytes) {
	const cursor = skipWhitespace(text, start);
	if (text[cursor] !== "{") return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = cursor; index < text.length; index += 1) {
		const char = text[index];
		if (index + 1 - cursor > maxPayloadBytes) return null;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				const rawJson = text.slice(cursor, index + 1);
				try {
					const parsed = JSON.parse(rawJson);
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
					return {
						end: index + 1,
						value: parsed
					};
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}
function parseClosing(text, start, name) {
	const cursor = skipWhitespace(text, start);
	if (text.startsWith(END_TOOL_REQUEST, cursor)) return cursor + 18;
	const namedClosing = `[/${name}]`;
	if (text.startsWith(namedClosing, cursor)) return cursor + namedClosing.length;
	return null;
}
function parsePlainTextToolCallBlockAt(text, start, options) {
	const opening = parseOpening(text, start);
	if (!opening) return null;
	const allowedToolNames = options?.allowedToolNames ? new Set(options.allowedToolNames) : void 0;
	if (allowedToolNames && !allowedToolNames.has(opening.name)) return null;
	const payload = consumeJsonObject(text, opening.end, options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES);
	if (!payload) return null;
	const end = parseClosing(text, payload.end, opening.name);
	if (end === null) return null;
	return {
		arguments: payload.value,
		end,
		name: opening.name,
		raw: text.slice(start, end),
		start
	};
}
function parseStandalonePlainTextToolCallBlocks(text, options) {
	const blocks = [];
	let cursor = skipWhitespace(text, 0);
	while (cursor < text.length) {
		const block = parsePlainTextToolCallBlockAt(text, cursor, options);
		if (!block) return null;
		blocks.push(block);
		cursor = skipWhitespace(text, block.end);
	}
	return blocks.length > 0 ? blocks : null;
}
function stripPlainTextToolCallBlocks(text) {
	if (!text || !/\[[A-Za-z0-9_-]+\]/.test(text)) return text;
	let result = "";
	let cursor = 0;
	let index = 0;
	while (index < text.length) {
		if (!(index === 0 || text[index - 1] === "\n")) {
			index += 1;
			continue;
		}
		const block = parsePlainTextToolCallBlockAt(text, skipHorizontalWhitespace(text, index));
		if (!block) {
			index += 1;
			continue;
		}
		result += text.slice(cursor, index);
		cursor = block.end;
		index = block.end;
	}
	result += text.slice(cursor);
	return result;
}
//#endregion
export { parseStandalonePlainTextToolCallBlocks as n, stripPlainTextToolCallBlocks as r, extractToolPayload as t };
