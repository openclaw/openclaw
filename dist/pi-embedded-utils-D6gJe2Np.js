import { a as parseAssistantTextSignature, i as normalizeAssistantPhase } from "./chat-message-content-DN9xEd6w.js";
import { n as extractTextFromChatContent } from "./chat-content-BNTcXm1Z.js";
import { t as sanitizeAssistantVisibleText, u as stripReasoningTagsFromText } from "./assistant-visible-text-BoF6Ixue.js";
import { d as sanitizeUserFacingText } from "./sanitize-user-facing-text-Df1D-hzs.js";
import { r as resolveToolDisplay, t as formatToolDetail } from "./tool-display-CN2B3x-5.js";
//#region src/agents/pi-embedded-utils.ts
function isAssistantMessage(msg) {
	return msg?.role === "assistant";
}
/**
* Strip thinking tags and their content from text.
* This is a safety net for cases where the model outputs <think> tags
* that slip through other filtering mechanisms.
*/
function stripThinkingTagsFromText(text) {
	return stripReasoningTagsFromText(text, {
		mode: "strict",
		trim: "both"
	});
}
function sanitizeAssistantText(text) {
	return sanitizeAssistantVisibleText(text);
}
function finalizeAssistantExtraction(msg, extracted) {
	return sanitizeUserFacingText(extracted, { errorContext: msg.stopReason === "error" });
}
function extractAssistantTextForPhase(msg, phase) {
	const messagePhase = normalizeAssistantPhase(msg.phase);
	const shouldIncludeContent = (resolvedPhase) => {
		if (phase) return resolvedPhase === phase;
		return resolvedPhase === void 0;
	};
	if (typeof msg.content === "string") {
		const hadRequestedPhase = phase ? messagePhase === phase : messagePhase === void 0;
		return {
			text: shouldIncludeContent(messagePhase) ? finalizeAssistantExtraction(msg, sanitizeAssistantText(msg.content)) : "",
			hadRequestedPhase
		};
	}
	if (!Array.isArray(msg.content)) return {
		text: "",
		hadRequestedPhase: false
	};
	const hasExplicitPhasedTextBlocks = msg.content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const record = block;
		if (record.type !== "text") return false;
		return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
	});
	let hadRequestedPhase = false;
	return {
		text: finalizeAssistantExtraction(msg, extractTextFromChatContent(msg.content.filter((block) => {
			if (!block || typeof block !== "object") return false;
			const record = block;
			if (record.type !== "text") return false;
			const resolvedPhase = parseAssistantTextSignature(record.textSignature)?.phase ?? (hasExplicitPhasedTextBlocks ? void 0 : messagePhase);
			if (phase ? resolvedPhase === phase : resolvedPhase === void 0) hadRequestedPhase = true;
			return shouldIncludeContent(resolvedPhase);
		}), {
			sanitizeText: (text) => sanitizeAssistantText(text),
			joinWith: "\n",
			normalizeText: (text) => text.trim()
		}) ?? ""),
		hadRequestedPhase
	};
}
function extractAssistantVisibleText(msg) {
	const finalAnswerExtraction = extractAssistantTextForPhase(msg, "final_answer");
	if (finalAnswerExtraction.hadRequestedPhase) return finalAnswerExtraction.text.trim() ? finalAnswerExtraction.text : "";
	return extractAssistantTextForPhase(msg).text;
}
function extractAssistantText(msg) {
	return finalizeAssistantExtraction(msg, extractTextFromChatContent(msg.content, {
		sanitizeText: (text) => sanitizeAssistantText(text),
		joinWith: "\n",
		normalizeText: (text) => text.trim()
	}) ?? "");
}
function extractAssistantThinking(msg) {
	if (!Array.isArray(msg.content)) return "";
	return msg.content.map((block) => {
		if (!block || typeof block !== "object") return "";
		const record = block;
		if (record.type === "thinking" && typeof record.thinking === "string") {
			const thinking = record.thinking.trim();
			if (thinking) return thinking;
			if (typeof record.thinkingSignature === "string" && record.thinkingSignature.trim()) return "Native reasoning was produced; no summary text was returned.";
		}
		return "";
	}).filter(Boolean).join("\n").trim();
}
function formatReasoningMessage(text) {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return `Thinking\n\n${trimmed.split("\n").map((line) => line ? `_${line}_` : line).join("\n")}`;
}
const THINKING_TAG_NAME_PATTERN = String.raw`(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)`;
const THINKING_TAG_OPEN_RE = new RegExp(String.raw`<\s*${THINKING_TAG_NAME_PATTERN}\s*>`, "i");
const THINKING_TAG_CLOSE_RE = new RegExp(String.raw`<\s*\/\s*${THINKING_TAG_NAME_PATTERN}\s*>`, "i");
const THINKING_TAG_OPEN_GLOBAL_RE = new RegExp(String.raw`<\s*${THINKING_TAG_NAME_PATTERN}\s*>`, "gi");
const THINKING_TAG_CLOSE_GLOBAL_RE = new RegExp(String.raw`<\s*\/\s*${THINKING_TAG_NAME_PATTERN}\s*>`, "gi");
const THINKING_TAG_SCAN_RE = new RegExp(String.raw`<\s*(\/?)\s*${THINKING_TAG_NAME_PATTERN}\s*>`, "gi");
function splitThinkingTaggedText(text) {
	const trimmedStart = text.trimStart();
	if (!trimmedStart.startsWith("<")) return null;
	if (!THINKING_TAG_OPEN_RE.test(trimmedStart)) return null;
	if (!THINKING_TAG_CLOSE_RE.test(text)) return null;
	let inThinking = false;
	let cursor = 0;
	let thinkingStart = 0;
	const blocks = [];
	const pushText = (value) => {
		if (!value) return;
		blocks.push({
			type: "text",
			text: value
		});
	};
	const pushThinking = (value) => {
		const cleaned = value.trim();
		if (!cleaned) return;
		blocks.push({
			type: "thinking",
			thinking: cleaned
		});
	};
	for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
		const index = match.index ?? 0;
		const isClose = match[1]?.includes("/") ?? false;
		if (!inThinking && !isClose) {
			pushText(text.slice(cursor, index));
			thinkingStart = index + match[0].length;
			inThinking = true;
			continue;
		}
		if (inThinking && isClose) {
			pushThinking(text.slice(thinkingStart, index));
			cursor = index + match[0].length;
			inThinking = false;
		}
	}
	if (inThinking) return null;
	pushText(text.slice(cursor));
	if (!blocks.some((b) => b.type === "thinking")) return null;
	return blocks;
}
function promoteThinkingTagsToBlocks(message) {
	if (!Array.isArray(message.content)) return;
	if (message.content.some((block) => block && typeof block === "object" && block.type === "thinking")) return;
	const next = [];
	let changed = false;
	for (const block of message.content) {
		if (!block || typeof block !== "object" || !("type" in block)) {
			next.push(block);
			continue;
		}
		if (block.type !== "text") {
			next.push(block);
			continue;
		}
		const split = splitThinkingTaggedText(block.text);
		if (!split) {
			next.push(block);
			continue;
		}
		changed = true;
		for (const part of split) if (part.type === "thinking") next.push({
			type: "thinking",
			thinking: part.thinking
		});
		else if (part.type === "text") {
			const cleaned = part.text.trimStart();
			if (cleaned) next.push({
				type: "text",
				text: cleaned
			});
		}
	}
	if (!changed) return;
	message.content = next;
}
function extractThinkingFromTaggedText(text) {
	if (!text) return "";
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
		const idx = match.index ?? 0;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = !(match[1] === "/");
		lastIndex = idx + match[0].length;
	}
	return result.trim();
}
function extractThinkingFromTaggedStream(text) {
	if (!text) return "";
	const closed = extractThinkingFromTaggedText(text);
	if (closed) return closed;
	const openMatches = [...text.matchAll(THINKING_TAG_OPEN_GLOBAL_RE)];
	if (openMatches.length === 0) return "";
	const closeMatches = [...text.matchAll(THINKING_TAG_CLOSE_GLOBAL_RE)];
	const lastOpen = openMatches[openMatches.length - 1];
	const lastClose = closeMatches[closeMatches.length - 1];
	if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) return closed;
	const start = (lastOpen.index ?? 0) + lastOpen[0].length;
	return text.slice(start).trim();
}
function inferToolMetaFromArgs(toolName, args, options) {
	return formatToolDetail(resolveToolDisplay({
		name: toolName,
		args,
		detailMode: options?.detailMode
	}));
}
//#endregion
export { extractThinkingFromTaggedStream as a, inferToolMetaFromArgs as c, splitThinkingTaggedText as d, stripThinkingTagsFromText as f, extractAssistantVisibleText as i, isAssistantMessage as l, extractAssistantText as n, extractThinkingFromTaggedText as o, extractAssistantThinking as r, formatReasoningMessage as s, THINKING_TAG_SCAN_RE as t, promoteThinkingTagsToBlocks as u };
