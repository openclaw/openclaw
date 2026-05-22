import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as stripPlainTextToolCallBlocks } from "./tool-payload-Gp3uQTKH.js";
//#region src/shared/text/code-regions.ts
function findCodeRegions(text) {
	const regions = [];
	for (const match of text.matchAll(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2|$)/g)) {
		const start = (match.index ?? 0) + match[1].length;
		regions.push({
			start,
			end: start + match[0].length - match[1].length
		});
	}
	for (const match of text.matchAll(/`+[^`]+`+/g)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (!regions.some((r) => start >= r.start && end <= r.end)) regions.push({
			start,
			end
		});
	}
	regions.sort((a, b) => a.start - b.start);
	return regions;
}
function isInsideCode(pos, regions) {
	return regions.some((r) => pos >= r.start && pos < r.end);
}
//#endregion
//#region src/shared/text/model-special-tokens.ts
/**
* Strip model control tokens leaked into assistant text output.
*
* Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
* (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
* in their responses. These use the universal `<|...|>` convention (ASCII or
* full-width pipe variants) and should never reach end users.
*
* Matches inside fenced code blocks or inline code spans are preserved so
* that documentation / examples that reference these tokens are not corrupted.
*
* This is a provider bug — no upstream fix tracked yet.
* Remove this function when upstream providers stop leaking tokens.
* @see https://github.com/openclaw/openclaw/issues/40020
*/
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;
function overlapsCodeRegion(start, end, codeRegions) {
	return codeRegions.some((region) => start < region.end && end > region.start);
}
function shouldInsertSeparator(before, after) {
	return Boolean(before && after && !/\s/.test(before) && !/\s/.test(after));
}
function stripModelSpecialTokens(text) {
	if (!text) return text;
	MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
	if (!MODEL_SPECIAL_TOKEN_RE.test(text)) return text;
	MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
	const codeRegions = findCodeRegions(text);
	let out = "";
	let cursor = 0;
	for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
		const matched = match[0];
		const start = match.index ?? 0;
		const end = start + matched.length;
		out += text.slice(cursor, start);
		if (isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)) out += matched;
		else if (shouldInsertSeparator(text[start - 1], text[end])) out += " ";
		cursor = end;
	}
	out += text.slice(cursor);
	return out;
}
//#endregion
//#region src/shared/text/final-tags.ts
const FINAL_TAG_CANDIDATE_RE = /<[^<>]*>/g;
function isWhitespace(char) {
	return /\s/.test(char);
}
function parseAttributeList(text) {
	let index = 0;
	while (index < text.length) {
		while (index < text.length && isWhitespace(text[index] ?? "")) index += 1;
		if (index >= text.length) return true;
		const nameStart = index;
		while (index < text.length) {
			const char = text[index] ?? "";
			if (isWhitespace(char) || char === "=") break;
			if (char === "/" || char === "\"" || char === "'" || char === "<" || char === ">") return false;
			index += 1;
		}
		if (index === nameStart) return false;
		while (index < text.length && isWhitespace(text[index] ?? "")) index += 1;
		if (text[index] !== "=") continue;
		index += 1;
		while (index < text.length && isWhitespace(text[index] ?? "")) index += 1;
		if (index >= text.length) return false;
		const quote = text[index];
		if (quote === "\"" || quote === "'") {
			index += 1;
			const end = text.indexOf(quote, index);
			if (end === -1) return false;
			index = end + 1;
			continue;
		}
		const valueStart = index;
		while (index < text.length && !isWhitespace(text[index] ?? "")) {
			const char = text[index] ?? "";
			if (char === "\"" || char === "'" || char === "<" || char === ">") return false;
			index += 1;
		}
		if (index === valueStart) return false;
	}
	return true;
}
function parseFinalTag(text) {
	if (!text.startsWith("<") || !text.endsWith(">")) return null;
	let body = text.slice(1, -1).trimStart();
	let isClose = false;
	if (body.startsWith("/")) {
		isClose = true;
		body = body.slice(1).trimStart();
	}
	if (!body.toLowerCase().startsWith("final")) return null;
	const boundary = body[5] ?? "";
	if (boundary && !isWhitespace(boundary) && boundary !== "/") return null;
	let rest = body.slice(5);
	if (isClose) return rest.trim().length === 0 ? {
		isClose: true,
		isSelfClosing: false
	} : null;
	const trimmedRest = rest.trimEnd();
	const isSelfClosing = trimmedRest.endsWith("/");
	rest = isSelfClosing ? trimmedRest.slice(0, -1) : rest;
	if (!parseAttributeList(rest)) return null;
	return {
		isClose: false,
		isSelfClosing
	};
}
function findFinalTagMatches(text) {
	const matches = [];
	for (const match of text.matchAll(FINAL_TAG_CANDIDATE_RE)) {
		const tagText = match[0];
		const parsed = parseFinalTag(tagText);
		if (!parsed) continue;
		matches.push({
			index: match.index ?? 0,
			text: tagText,
			...parsed
		});
	}
	return matches;
}
function stripFinalTags(text) {
	let output = "";
	let lastIndex = 0;
	for (const match of findFinalTagMatches(text)) {
		output += text.slice(lastIndex, match.index);
		lastIndex = match.index + match.text.length;
	}
	output += text.slice(lastIndex);
	return output;
}
//#endregion
//#region src/shared/text/reasoning-tags.ts
const QUICK_TAG_RE = /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking|final)\b/i;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
function applyTrim(value, mode) {
	if (mode === "none") return value;
	if (mode === "start") return value.trimStart();
	return value.trim();
}
function hasOrphanReasoningCloseBoundary(params) {
	return params.before.trim().length > 0 && params.after.trim().length > 0;
}
function stripReasoningTagsFromText(text, options) {
	if (!text) return text;
	if (!QUICK_TAG_RE.test(text)) return text;
	const mode = options?.mode ?? "strict";
	const trimMode = options?.trim ?? "both";
	let cleaned = text;
	const matches = findFinalTagMatches(cleaned);
	THINKING_TAG_RE.lastIndex = 0;
	const hasThinkingTag = THINKING_TAG_RE.test(cleaned);
	THINKING_TAG_RE.lastIndex = 0;
	if (matches.length === 0 && !hasThinkingTag) return text;
	if (matches.length > 0) {
		const finalMatches = [];
		const preCodeRegions = findCodeRegions(cleaned);
		for (const match of matches) {
			const start = match.index;
			finalMatches.push({
				start,
				length: match.text.length,
				inCode: isInsideCode(start, preCodeRegions)
			});
		}
		for (let i = finalMatches.length - 1; i >= 0; i--) {
			const m = finalMatches[i];
			if (!m.inCode) cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
		}
	}
	const codeRegions = findCodeRegions(cleaned);
	THINKING_TAG_RE.lastIndex = 0;
	let result = "";
	let lastIndex = 0;
	let thinkingDepth = 0;
	let firstUnclosedContentIndex;
	for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
		const idx = match.index ?? 0;
		const isClose = match[1] === "/";
		if (isInsideCode(idx, codeRegions)) continue;
		if (thinkingDepth === 0) {
			if (isClose) {
				const afterIndex = idx + match[0].length;
				const before = cleaned.slice(lastIndex, idx);
				if (hasOrphanReasoningCloseBoundary({
					before,
					after: cleaned.slice(afterIndex)
				})) result = "";
				else result += before;
				lastIndex = afterIndex;
				continue;
			}
			result += cleaned.slice(lastIndex, idx);
			thinkingDepth = 1;
			firstUnclosedContentIndex = idx + match[0].length;
		} else if (isClose) {
			thinkingDepth -= 1;
			if (thinkingDepth === 0) firstUnclosedContentIndex = void 0;
		} else thinkingDepth += 1;
		lastIndex = idx + match[0].length;
	}
	if (thinkingDepth === 0 || mode === "preserve") result += cleaned.slice(lastIndex);
	const trimmedResult = applyTrim(result, trimMode);
	if (mode === "strict" && thinkingDepth > 0 && !trimmedResult && firstUnclosedContentIndex !== void 0 && cleaned.trim()) return applyTrim(cleaned.slice(firstUnclosedContentIndex), trimMode);
	return trimmedResult;
}
//#endregion
//#region src/shared/text/assistant-visible-text.ts
const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;
/**
* Strip XML-style tool call tags that models sometimes emit as plain text.
* This stateful pass hides content from an opening tag through the matching
* closing tag, or to end-of-string if the stream was truncated mid-tag.
*/
const TOOL_CALL_QUICK_RE = /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
	"tool_call",
	"tool_result",
	"function_call",
	"function_calls",
	"function_response",
	"function",
	"tool_calls"
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE = /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;
const TOOL_CALL_XML_PAYLOAD_START_RE = /^\s*(?:\r?\n\s*)?<(?:function_call|tool_call|function|invoke|parameters?|arguments?)\b/i;
const NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE = /^\s*(?:\r?\n\s*)?<(?:function_call|tool_call)\b/i;
function endsInsideQuotedString(text, start, end) {
	let quoteChar = null;
	let isEscaped = false;
	for (let idx = start; idx < end; idx += 1) {
		const char = text[idx];
		if (quoteChar === null) {
			if (char === "\"" || char === "'") quoteChar = char;
			continue;
		}
		if (isEscaped) {
			isEscaped = false;
			continue;
		}
		if (char === "\\") {
			isEscaped = true;
			continue;
		}
		if (char === quoteChar) quoteChar = null;
	}
	return quoteChar !== null;
}
function isToolCallBoundary(char) {
	return !char || /\s/.test(char) || char === "/" || char === ">";
}
function findTagCloseIndex(text, start) {
	let quoteChar = null;
	let isEscaped = false;
	for (let idx = start; idx < text.length; idx += 1) {
		const char = text[idx];
		if (quoteChar !== null) {
			if (isEscaped) {
				isEscaped = false;
				continue;
			}
			if (char === "\\") {
				isEscaped = true;
				continue;
			}
			if (char === quoteChar) quoteChar = null;
			continue;
		}
		if (char === "\"" || char === "'") {
			quoteChar = char;
			continue;
		}
		if (char === "<") return -1;
		if (char === ">") return idx;
	}
	return -1;
}
function detectToolCallPayloadKind(text, start) {
	const rest = text.slice(start);
	if (TOOL_CALL_JSON_PAYLOAD_START_RE.test(rest)) return "json";
	if (TOOL_CALL_XML_PAYLOAD_START_RE.test(rest)) return "xml";
	return null;
}
function startsWithNestedJsonToolCallPayload(text, start) {
	if (!NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE.test(text.slice(start))) return false;
	let cursor = start;
	while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
	const nestedTag = parseToolCallTagAt(text, cursor);
	if (!nestedTag || nestedTag.isClose || nestedTag.isSelfClosing || nestedTag.isTruncated || nestedTag.tagName !== "function_call" && nestedTag.tagName !== "tool_call") return false;
	return TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(nestedTag.end));
}
function isLikelyStandaloneFunctionToolCall(text, tagStart, tag) {
	if (tag.tagName !== "function" || tag.isClose || tag.isSelfClosing || tag.isTruncated) return false;
	if (!/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) return false;
	let idx = tagStart - 1;
	while (idx >= 0 && (text[idx] === " " || text[idx] === "	")) idx -= 1;
	return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text[idx]);
}
function isStandaloneOpeningTagLine(text, tagStart, tag) {
	let idx = tagStart - 1;
	while (idx >= 0 && (text[idx] === " " || text[idx] === "	")) idx -= 1;
	if (!(idx < 0 || text[idx] === "\n" || text[idx] === "\r")) return false;
	let after = tag.end;
	while (after < text.length && (text[after] === " " || text[after] === "	")) after += 1;
	return after >= text.length || text[after] === "\n" || text[after] === "\r";
}
function isOpeningTagFollowedByLineBreak(text, tag) {
	let after = tag.end;
	while (after < text.length && (text[after] === " " || text[after] === "	")) after += 1;
	return after >= text.length || text[after] === "\n" || text[after] === "\r";
}
function hasSameLineContentAfterOpeningTag(text, tag) {
	let after = tag.end;
	while (after < text.length && (text[after] === " " || text[after] === "	")) after += 1;
	return after < text.length && text[after] !== "\n" && text[after] !== "\r";
}
function isVisibleLineStart(text) {
	let idx = text.length - 1;
	while (idx >= 0 && (text[idx] === " " || text[idx] === "	")) idx -= 1;
	return idx < 0 || text[idx] === "\n" || text[idx] === "\r";
}
function isAdjacentToStrippedToolCallBlock(text, tagStart, lastStrippedBlockEnd) {
	if (lastStrippedBlockEnd === null || lastStrippedBlockEnd > tagStart) return false;
	for (let idx = lastStrippedBlockEnd; idx < tagStart; idx += 1) if (text[idx] !== " " && text[idx] !== "	" && text[idx] !== "\n" && text[idx] !== "\r") return false;
	return true;
}
function findMatchingToolCallCloseIndex(text, start, tagName) {
	for (let idx = start; idx < text.length; idx += 1) {
		if (text[idx] !== "<") continue;
		const tag = parseToolCallTagAt(text, idx);
		if (!tag) continue;
		if (tag.isClose && tag.tagName === tagName && !tag.isTruncated) return idx;
		idx = Math.max(idx, tag.end - 1);
	}
	return -1;
}
function findAdjacentOpeningToolCallTag(text, start, tagName) {
	let idx = start;
	while (idx < text.length && /\s/.test(text[idx])) idx += 1;
	if (text[idx] !== "<") return null;
	const tag = parseToolCallTagAt(text, idx);
	if (!tag || tag.isClose || tag.tagName !== tagName) return null;
	return tag;
}
function parseToolCallTagAt(text, start) {
	if (text[start] !== "<") return null;
	let cursor = start + 1;
	while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
	let isClose = false;
	if (text[cursor] === "/") {
		isClose = true;
		cursor += 1;
		while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
	}
	const nameStart = cursor;
	while (cursor < text.length && /[A-Za-z_]/.test(text[cursor])) cursor += 1;
	const tagName = normalizeLowercaseStringOrEmpty(text.slice(nameStart, cursor));
	if (!TOOL_CALL_TAG_NAMES.has(tagName) || !isToolCallBoundary(text[cursor])) return null;
	const contentStart = cursor;
	const closeIndex = findTagCloseIndex(text, cursor);
	if (closeIndex === -1) return {
		contentStart,
		end: text.length,
		isClose,
		isSelfClosing: false,
		tagName,
		isTruncated: true
	};
	return {
		contentStart,
		end: closeIndex + 1,
		isClose,
		isSelfClosing: !isClose && /\/\s*$/.test(text.slice(cursor, closeIndex)),
		tagName,
		isTruncated: false
	};
}
function stripToolCallXmlTags(text, options = {}) {
	if (!text || !TOOL_CALL_QUICK_RE.test(text)) return text;
	const codeRegions = findCodeRegions(text);
	let result = "";
	let lastIndex = 0;
	let inToolCallBlock = false;
	let toolCallBlockContentStart = 0;
	let toolCallBlockNeedsQuoteBalance = false;
	let toolCallBlockStart = 0;
	let toolCallBlockTagName = null;
	let lastStrippedToolCallBlockEnd = null;
	const visibleTagBalance = /* @__PURE__ */ new Map();
	for (let idx = 0; idx < text.length; idx += 1) {
		if (text[idx] !== "<") continue;
		if (!inToolCallBlock && isInsideCode(idx, codeRegions)) continue;
		const tag = parseToolCallTagAt(text, idx);
		if (!tag) continue;
		if (!inToolCallBlock) {
			result += text.slice(lastIndex, idx);
			if (tag.isClose) {
				if (tag.isTruncated) {
					const preserveEnd = tag.contentStart;
					result += text.slice(idx, preserveEnd);
					lastIndex = preserveEnd;
					idx = Math.max(idx, preserveEnd - 1);
					continue;
				}
				const balance = visibleTagBalance.get(tag.tagName) ?? 0;
				if (balance > 0) {
					result += text.slice(idx, tag.end);
					visibleTagBalance.set(tag.tagName, balance - 1);
				}
				lastIndex = tag.end;
				idx = Math.max(idx, tag.end - 1);
				continue;
			}
			if (tag.isSelfClosing) {
				lastStrippedToolCallBlockEnd = tag.end;
				lastIndex = tag.end;
				idx = Math.max(idx, tag.end - 1);
				continue;
			}
			const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
			const isPluralToolCallWrapper = tag.tagName === "function_calls" || tag.tagName === "tool_calls";
			const matchingCloseStart = isPluralToolCallWrapper ? findMatchingToolCallCloseIndex(text, tag.end, tag.tagName) : -1;
			const matchingCloseTag = matchingCloseStart === -1 ? null : parseToolCallTagAt(text, matchingCloseStart);
			const shouldStripPluralWrapperBeforeResponse = options.stripFunctionResponseAfterPluralToolCalls === true && isPluralToolCallWrapper && matchingCloseTag !== null && findAdjacentOpeningToolCallTag(text, matchingCloseTag.end, "function_response") !== null;
			const payloadKind = tag.tagName === "tool_call" || tag.tagName === "function" || (options.stripFunctionCallsXmlPayloads === true || shouldStripPluralWrapperBeforeResponse) && isPluralToolCallWrapper ? detectToolCallPayloadKind(text, payloadStart) : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart)) ? "json" : null;
			const shouldStripStandaloneFunction = tag.tagName !== "function" || isLikelyStandaloneFunctionToolCall(text, idx, tag);
			const functionResponseCloseStart = tag.tagName === "function_response" ? findMatchingToolCallCloseIndex(text, tag.end, tag.tagName) : -1;
			const shouldStripAdjacentResult = isAdjacentToStrippedToolCallBlock(text, idx, lastStrippedToolCallBlockEnd) && (isOpeningTagFollowedByLineBreak(text, tag) || functionResponseCloseStart !== -1 || hasSameLineContentAfterOpeningTag(text, tag));
			const shouldStripStandaloneResult = tag.tagName === "function_response" && (isStandaloneOpeningTagLine(text, idx, tag) || shouldStripAdjacentResult || functionResponseCloseStart !== -1 && isVisibleLineStart(result) && isOpeningTagFollowedByLineBreak(text, tag));
			if (!tag.isClose && (payloadKind && shouldStripStandaloneFunction || shouldStripStandaloneResult)) {
				inToolCallBlock = true;
				toolCallBlockContentStart = tag.end;
				toolCallBlockNeedsQuoteBalance = payloadKind === "json" || payloadKind === "xml" && startsWithNestedJsonToolCallPayload(text, payloadStart);
				toolCallBlockStart = idx;
				toolCallBlockTagName = tag.tagName;
				if (tag.isTruncated) {
					lastIndex = text.length;
					break;
				}
			} else {
				const preserveEnd = tag.isTruncated ? tag.contentStart : tag.end;
				result += text.slice(idx, preserveEnd);
				if (!tag.isTruncated) visibleTagBalance.set(tag.tagName, (visibleTagBalance.get(tag.tagName) ?? 0) + 1);
				lastIndex = preserveEnd;
				idx = Math.max(idx, preserveEnd - 1);
				continue;
			}
		} else if (tag.isClose && (tag.tagName === toolCallBlockTagName || toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call") && (!toolCallBlockNeedsQuoteBalance || !endsInsideQuotedString(text, toolCallBlockContentStart, idx))) {
			const closedBlockTagName = toolCallBlockTagName;
			inToolCallBlock = false;
			toolCallBlockNeedsQuoteBalance = false;
			toolCallBlockTagName = null;
			if (closedBlockTagName) lastStrippedToolCallBlockEnd = tag.end;
		}
		lastIndex = tag.end;
		idx = Math.max(idx, tag.end - 1);
	}
	if (!inToolCallBlock) result += text.slice(lastIndex);
	else if (toolCallBlockTagName === "function") result += text.slice(toolCallBlockStart);
	return result;
}
/**
* Strip malformed Minimax tool invocations that leak into text content.
* Minimax sometimes embeds tool calls as XML in text blocks instead of
* proper structured tool calls.
*/
function stripMinimaxToolCallXml(text) {
	if (!text || !/minimax:tool_call/i.test(text)) return text;
	const codeRegions = findCodeRegions(text);
	const minimaxToolXmlRe = /<invoke\b[^>]*>[\s\S]*?<\/invoke>|<\/?minimax:tool_call>/gi;
	let result = "";
	let cursor = 0;
	for (const match of text.matchAll(minimaxToolXmlRe)) {
		const start = match.index ?? 0;
		if (isInsideCode(start, codeRegions)) continue;
		result += text.slice(cursor, start);
		cursor = start + match[0].length;
	}
	result += text.slice(cursor);
	return result;
}
function isLegacyBracketToolCallPayload(value) {
	return /\btool\s*=>\s*["'][A-Za-z_][A-Za-z0-9_.:-]{0,119}["']/i.test(value) && /\bargs\s*=>/i.test(value);
}
function isLegacyBracketToolResultPayload(value) {
	return /^\s*[{[]/.test(value) || /\b(?:tool|result|output|content)\s*=>/i.test(value) || /\b(?:tool|result|output|content)\s*:/i.test(value);
}
function stripLegacyBracketToolCallBlocks(text) {
	if (!text || !LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE.test(text)) return text;
	const codeRegions = findCodeRegions(text);
	let result = "";
	let cursor = 0;
	while (cursor < text.length) {
		const openMatch = /\[\s*TOOL_(CALL|RESULT)\s*\]/gi.exec(text.slice(cursor));
		if (!openMatch?.[0]) {
			result += text.slice(cursor);
			break;
		}
		const blockKind = openMatch[1]?.toUpperCase();
		const openStart = cursor + (openMatch.index ?? 0);
		const payloadStart = openStart + openMatch[0].length;
		if (isInsideCode(openStart, codeRegions)) {
			result += text.slice(cursor, payloadStart);
			cursor = payloadStart;
			continue;
		}
		const closeMatch = (blockKind === "RESULT" ? /\[\s*\/\s*TOOL_RESULT\s*\]/gi : /\[\s*\/\s*TOOL_CALL\s*\]/gi).exec(text.slice(payloadStart));
		const closeStart = closeMatch?.[0] && !isInsideCode(payloadStart + (closeMatch.index ?? 0), codeRegions) ? payloadStart + (closeMatch.index ?? 0) : -1;
		const payloadEnd = closeStart >= 0 ? closeStart : text.length;
		const payload = text.slice(payloadStart, payloadEnd);
		if (!(blockKind === "RESULT" ? isLegacyBracketToolResultPayload(payload) : isLegacyBracketToolCallPayload(payload))) {
			result += text.slice(cursor, payloadStart);
			cursor = payloadStart;
			continue;
		}
		result += text.slice(cursor, openStart);
		cursor = closeStart >= 0 ? closeStart + (closeMatch?.[0].length ?? 0) : text.length;
	}
	return result;
}
/**
* Strip downgraded tool call text representations that leak into user-visible
* text content when replaying history across providers.
*/
function stripDowngradedToolCallText(text) {
	if (!text) return text;
	if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) return text;
	const consumeJsonish = (input, start, options) => {
		const { allowLeadingNewlines = false } = options ?? {};
		let index = start;
		while (index < input.length) {
			const ch = input[index];
			if (ch === " " || ch === "	") {
				index += 1;
				continue;
			}
			if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
				index += 1;
				continue;
			}
			break;
		}
		if (index >= input.length) return null;
		const startChar = input[index];
		if (startChar === "{" || startChar === "[") {
			let depth = 0;
			let inString = false;
			let escape = false;
			for (let idx = index; idx < input.length; idx += 1) {
				const ch = input[idx];
				if (inString) {
					if (escape) escape = false;
					else if (ch === "\\") escape = true;
					else if (ch === "\"") inString = false;
					continue;
				}
				if (ch === "\"") {
					inString = true;
					continue;
				}
				if (ch === "{" || ch === "[") depth += 1;
				else if (ch === "}" || ch === "]") {
					depth -= 1;
					if (depth === 0) return idx + 1;
				}
			}
			return null;
		}
		if (startChar === "\"") {
			let escape = false;
			for (let idx = index + 1; idx < input.length; idx += 1) {
				const ch = input[idx];
				if (escape) {
					escape = false;
					continue;
				}
				if (ch === "\\") {
					escape = true;
					continue;
				}
				if (ch === "\"") return idx + 1;
			}
			return null;
		}
		let end = index;
		while (end < input.length && input[end] !== "\n" && input[end] !== "\r") end += 1;
		return end;
	};
	const stripToolCalls = (input) => {
		const toolCallRe = /\[Tool Call:[^\]]*\]/gi;
		let result = "";
		let cursor = 0;
		for (const match of input.matchAll(toolCallRe)) {
			const start = match.index ?? 0;
			if (start < cursor) continue;
			result += input.slice(cursor, start);
			let index = start + match[0].length;
			while (index < input.length && (input[index] === " " || input[index] === "	")) index += 1;
			if (input[index] === "\r") {
				index += 1;
				if (input[index] === "\n") index += 1;
			} else if (input[index] === "\n") index += 1;
			while (index < input.length && (input[index] === " " || input[index] === "	")) index += 1;
			if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
				index += 9;
				if (input[index] === ":") index += 1;
				if (input[index] === " ") index += 1;
				const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
				if (end !== null) index = end;
			}
			if ((input[index] === "\n" || input[index] === "\r") && (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)) {
				if (input[index] === "\r") index += 1;
				if (input[index] === "\n") index += 1;
			}
			cursor = index;
		}
		result += input.slice(cursor);
		return result;
	};
	let cleaned = stripToolCalls(text);
	cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");
	cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");
	return cleaned.trim();
}
function stripRelevantMemoriesTags(text) {
	if (!text || !MEMORY_TAG_QUICK_RE.test(text)) return text;
	MEMORY_TAG_RE.lastIndex = 0;
	const codeRegions = findCodeRegions(text);
	let result = "";
	let lastIndex = 0;
	let inMemoryBlock = false;
	for (const match of text.matchAll(MEMORY_TAG_RE)) {
		const idx = match.index ?? 0;
		if (isInsideCode(idx, codeRegions)) continue;
		const isClose = match[1] === "/";
		if (!inMemoryBlock) {
			result += text.slice(lastIndex, idx);
			if (!isClose) inMemoryBlock = true;
		} else if (isClose) inMemoryBlock = false;
		lastIndex = idx + match[0].length;
	}
	if (!inMemoryBlock) result += text.slice(lastIndex);
	return result;
}
const ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS = {
	delivery: {
		finalTrim: "both",
		stripFunctionResponseAfterPluralToolCalls: true,
		reasoningMode: "strict",
		reasoningTrim: "both",
		stageOrder: "reasoning-last"
	},
	history: {
		finalTrim: "none",
		reasoningMode: "strict",
		reasoningTrim: "none",
		stageOrder: "reasoning-last"
	},
	"internal-scaffolding": {
		finalTrim: "start",
		preserveDowngradedToolText: true,
		preserveMinimaxToolXml: true,
		reasoningMode: "preserve",
		reasoningTrim: "start",
		stageOrder: "reasoning-first"
	}
};
function applyAssistantVisibleTextStagePipeline(text, options) {
	if (!text) return text;
	const stripReasoning = (value) => stripReasoningTagsFromText(value, {
		mode: options.reasoningMode,
		trim: options.reasoningTrim
	});
	const applyFinalTrim = (value) => {
		if (options.finalTrim === "none") return value;
		if (options.finalTrim === "start") return value.trimStart();
		return value.trim();
	};
	const stripNonReasoningStages = (value) => {
		let cleaned = value;
		if (!options.preserveMinimaxToolXml) cleaned = stripMinimaxToolCallXml(cleaned);
		cleaned = stripModelSpecialTokens(cleaned);
		cleaned = stripRelevantMemoriesTags(cleaned);
		cleaned = stripToolCallXmlTags(cleaned, {
			stripFunctionCallsXmlPayloads: options.stripFunctionCallsXmlPayloads,
			stripFunctionResponseAfterPluralToolCalls: options.stripFunctionResponseAfterPluralToolCalls
		});
		cleaned = stripLegacyBracketToolCallBlocks(cleaned);
		cleaned = stripPlainTextToolCallBlocks(cleaned);
		if (!options.preserveDowngradedToolText) cleaned = stripDowngradedToolCallText(cleaned);
		return cleaned;
	};
	if (options.stageOrder === "reasoning-first") return applyFinalTrim(stripNonReasoningStages(stripReasoning(text)));
	return applyFinalTrim(stripReasoning(stripNonReasoningStages(text)));
}
function sanitizeAssistantVisibleTextWithProfile(text, profile = "delivery") {
	return applyAssistantVisibleTextStagePipeline(text, ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS[profile]);
}
function stripAssistantInternalScaffolding(text) {
	return sanitizeAssistantVisibleTextWithProfile(text, "internal-scaffolding");
}
/**
* Canonical user-visible assistant text sanitizer for delivery and history
* extraction paths. Keeps prose, removes internal scaffolding.
*/
function sanitizeAssistantVisibleText(text) {
	return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
}
/**
* Backwards-compatible trim wrapper.
* Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
*/
function sanitizeAssistantVisibleTextWithOptions(text, options) {
	return sanitizeAssistantVisibleTextWithProfile(text, options?.trim === "none" ? "history" : "delivery");
}
//#endregion
export { stripDowngradedToolCallText as a, stripToolCallXmlTags as c, findFinalTagMatches as d, stripFinalTags as f, isInsideCode as h, stripAssistantInternalScaffolding as i, hasOrphanReasoningCloseBoundary as l, findCodeRegions as m, sanitizeAssistantVisibleTextWithOptions as n, stripLegacyBracketToolCallBlocks as o, stripModelSpecialTokens as p, sanitizeAssistantVisibleTextWithProfile as r, stripMinimaxToolCallXml as s, sanitizeAssistantVisibleText as t, stripReasoningTagsFromText as u };
