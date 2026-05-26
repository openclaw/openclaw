import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { n as isSafeFenceBreak, r as parseFenceSpans, t as findFenceSpanAt } from "./fences-BFtCDO5A.js";
import { C as resolveChannelStreamingChunkMode } from "./channel-streaming-BKIuGSWW.js";
//#region src/shared/text-chunking.ts
function chunkTextByBreakResolver(text, limit, resolveBreakIndex) {
	if (!text) return [];
	if (limit <= 0 || text.length <= limit) return [text];
	const chunks = [];
	let remaining = text;
	while (remaining.length > limit) {
		const candidateBreak = resolveBreakIndex(remaining.slice(0, limit));
		const breakIdx = Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit ? candidateBreak : limit;
		const chunk = remaining.slice(0, breakIdx).trimEnd();
		if (chunk.length > 0) chunks.push(chunk);
		const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
		const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
		remaining = remaining.slice(nextStart).trimStart();
	}
	if (remaining.length) chunks.push(remaining);
	return chunks;
}
//#endregion
//#region src/auto-reply/chunk.ts
const DEFAULT_CHUNK_LIMIT = 4e3;
const DEFAULT_CHUNK_MODE = "length";
function resolveChunkLimitForProvider(cfgSection, accountId) {
	if (!cfgSection) return;
	const normalizedAccountId = normalizeAccountId(accountId);
	const accounts = cfgSection.accounts;
	if (accounts && typeof accounts === "object") {
		const direct = resolveAccountEntry(accounts, normalizedAccountId);
		if (typeof direct?.textChunkLimit === "number") return direct.textChunkLimit;
	}
	return cfgSection.textChunkLimit;
}
function resolveTextChunkLimit(cfg, provider, accountId, opts) {
	const fallback = typeof opts?.fallbackLimit === "number" && opts.fallbackLimit > 0 ? opts.fallbackLimit : DEFAULT_CHUNK_LIMIT;
	const providerOverride = (() => {
		if (!provider) return;
		return resolveChunkLimitForProvider((cfg?.channels)?.[provider] ?? cfg?.[provider], accountId);
	})();
	if (typeof providerOverride === "number" && providerOverride > 0) return providerOverride;
	return fallback;
}
function resolveChunkModeForProvider(cfgSection, accountId) {
	if (!cfgSection) return;
	const normalizedAccountId = normalizeAccountId(accountId);
	const accounts = cfgSection.accounts;
	if (accounts && typeof accounts === "object") {
		const directMode = resolveChannelStreamingChunkMode(resolveAccountEntry(accounts, normalizedAccountId));
		if (directMode) return directMode;
	}
	return resolveChannelStreamingChunkMode(cfgSection) ?? cfgSection.chunkMode;
}
function resolveChunkMode(cfg, provider, accountId) {
	if (!provider) return DEFAULT_CHUNK_MODE;
	return resolveChunkModeForProvider((cfg?.channels)?.[provider] ?? cfg?.[provider], accountId) ?? DEFAULT_CHUNK_MODE;
}
/**
* Split text on newlines, trimming line whitespace.
* Blank lines are folded into the next non-empty line as leading "\n" prefixes.
* Long lines can be split by length (default) or kept intact via splitLongLines:false.
*/
function chunkByNewline(text, maxLineLength, opts) {
	if (!text) return [];
	if (maxLineLength <= 0) return text.trim() ? [text] : [];
	const splitLongLines = opts?.splitLongLines !== false;
	const trimLines = opts?.trimLines !== false;
	const lines = splitByNewline(text, opts?.isSafeBreak);
	const chunks = [];
	let pendingBlankLines = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			pendingBlankLines += 1;
			continue;
		}
		const maxPrefix = Math.max(0, maxLineLength - 1);
		const cappedBlankLines = pendingBlankLines > 0 ? Math.min(pendingBlankLines, maxPrefix) : 0;
		const prefix = cappedBlankLines > 0 ? "\n".repeat(cappedBlankLines) : "";
		pendingBlankLines = 0;
		const lineValue = trimLines ? trimmed : line;
		if (!splitLongLines || lineValue.length + prefix.length <= maxLineLength) {
			chunks.push(prefix + lineValue);
			continue;
		}
		const firstLimit = Math.max(1, maxLineLength - prefix.length);
		const first = lineValue.slice(0, firstLimit);
		chunks.push(prefix + first);
		const remaining = lineValue.slice(firstLimit);
		if (remaining) chunks.push(...chunkText(remaining, maxLineLength));
	}
	if (pendingBlankLines > 0 && chunks.length > 0) chunks[chunks.length - 1] += "\n".repeat(pendingBlankLines);
	return chunks;
}
/**
* Split text into chunks on paragraph boundaries (blank lines), preserving lists and
* single-newline line wraps inside paragraphs.
*
* - Only breaks at paragraph separators ("\n\n" or more, allowing whitespace on blank lines)
* - Packs multiple paragraphs into a single chunk up to `limit`
* - Falls back to length-based splitting when a single paragraph exceeds `limit`
*   (unless `splitLongParagraphs` is disabled)
*/
function chunkByParagraph(text, limit, opts) {
	if (!text) return [];
	if (limit <= 0) return [text];
	const splitLongParagraphs = opts?.splitLongParagraphs !== false;
	const normalized = text.replace(/\r\n?/g, "\n");
	if (!/\n[\t ]*\n+/.test(normalized)) {
		if (normalized.length <= limit) return [normalized];
		if (!splitLongParagraphs) return [normalized];
		return chunkText(normalized, limit);
	}
	const spans = parseFenceSpans(normalized);
	const parts = [];
	const re = /\n[\t ]*\n+/g;
	let lastIndex = 0;
	for (const match of normalized.matchAll(re)) {
		const idx = match.index ?? 0;
		if (!isSafeFenceBreak(spans, idx)) continue;
		parts.push(normalized.slice(lastIndex, idx));
		lastIndex = idx + match[0].length;
	}
	parts.push(normalized.slice(lastIndex));
	const chunks = [];
	for (const part of parts) {
		const paragraph = part.replace(/\s+$/g, "");
		if (!paragraph.trim()) continue;
		if (paragraph.length <= limit) chunks.push(paragraph);
		else if (!splitLongParagraphs) chunks.push(paragraph);
		else chunks.push(...chunkText(paragraph, limit));
	}
	return chunks;
}
/**
* Unified chunking function that dispatches based on mode.
*/
function chunkTextWithMode(text, limit, mode) {
	if (mode === "newline") return chunkByParagraph(text, limit);
	return chunkText(text, limit);
}
function chunkMarkdownTextWithMode(text, limit, mode) {
	if (mode === "newline") {
		const paragraphChunks = chunkByParagraph(text, limit, { splitLongParagraphs: false });
		const out = [];
		for (const chunk of paragraphChunks) {
			const nested = chunkMarkdownText(chunk, limit);
			if (!nested.length && chunk) out.push(chunk);
			else out.push(...nested);
		}
		return out;
	}
	return chunkMarkdownText(text, limit);
}
function splitByNewline(text, isSafeBreak = () => true) {
	const lines = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) if (text[i] === "\n" && isSafeBreak(i)) {
		lines.push(text.slice(start, i));
		start = i + 1;
	}
	lines.push(text.slice(start));
	return lines;
}
function resolveChunkEarlyReturn(text, limit) {
	if (!text) return [];
	if (limit <= 0) return [text];
	if (text.length <= limit) return [text];
}
function chunkText(text, limit) {
	const early = resolveChunkEarlyReturn(text, limit);
	if (early) return early;
	return chunkTextByBreakResolver(text, limit, (window) => {
		const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, 0, window.length);
		return lastNewline > 0 ? lastNewline : lastWhitespace;
	});
}
function chunkMarkdownText(text, limit) {
	const early = resolveChunkEarlyReturn(text, limit);
	if (early) return early;
	const chunks = [];
	const spans = parseFenceSpans(text);
	let start = 0;
	let reopenFence;
	while (start < text.length) {
		const reopenPrefix = reopenFence ? `${reopenFence.openLine}\n` : "";
		const contentLimit = Math.max(1, limit - reopenPrefix.length);
		if (text.length - start <= contentLimit) {
			const finalChunk = `${reopenPrefix}${text.slice(start)}`;
			if (finalChunk.length > 0) chunks.push(finalChunk);
			break;
		}
		const windowEnd = Math.min(text.length, start + contentLimit);
		const softBreak = pickSafeBreakIndex(text, start, windowEnd, spans);
		let breakIdx = softBreak > start ? softBreak : windowEnd;
		const initialFence = isSafeFenceBreak(spans, breakIdx) ? void 0 : findFenceSpanAt(spans, breakIdx);
		let fenceToSplit = initialFence;
		if (initialFence) {
			const closeLine = `${initialFence.indent}${initialFence.marker}`;
			const maxIdxIfNeedNewline = start + (contentLimit - (closeLine.length + 1));
			if (maxIdxIfNeedNewline <= start) {
				fenceToSplit = void 0;
				breakIdx = windowEnd;
			} else {
				const minProgressIdx = Math.min(text.length, Math.max(start + 1, initialFence.start + initialFence.openLine.length + 2));
				const maxIdxIfAlreadyNewline = start + (contentLimit - closeLine.length);
				let pickedNewline = false;
				let lastNewline = text.lastIndexOf("\n", Math.max(start, maxIdxIfAlreadyNewline - 1));
				while (lastNewline >= start) {
					const candidateBreak = lastNewline + 1;
					if (candidateBreak < minProgressIdx) break;
					const candidateFence = findFenceSpanAt(spans, candidateBreak);
					if (candidateFence && candidateFence.start === initialFence.start) {
						breakIdx = candidateBreak;
						pickedNewline = true;
						break;
					}
					lastNewline = text.lastIndexOf("\n", lastNewline - 1);
				}
				if (!pickedNewline) if (minProgressIdx > maxIdxIfAlreadyNewline) {
					fenceToSplit = void 0;
					breakIdx = windowEnd;
				} else breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
			}
			const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
			fenceToSplit = fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : void 0;
		}
		const rawContent = text.slice(start, breakIdx);
		if (!rawContent) break;
		let rawChunk = `${reopenPrefix}${rawContent}`;
		const brokeOnSeparator = breakIdx < text.length && /\s/.test(text[breakIdx]);
		let nextStart = Math.min(text.length, breakIdx + (brokeOnSeparator ? 1 : 0));
		if (fenceToSplit) {
			const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
			rawChunk = rawChunk.endsWith("\n") ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
			reopenFence = fenceToSplit;
		} else {
			nextStart = skipLeadingNewlines(text, nextStart);
			reopenFence = void 0;
		}
		chunks.push(rawChunk);
		start = nextStart;
	}
	return chunks;
}
function skipLeadingNewlines(value, start = 0) {
	let i = start;
	while (i < value.length && value[i] === "\n") i++;
	return i;
}
function pickSafeBreakIndex(text, start, end, spans) {
	const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(text, start, end, (index) => isSafeFenceBreak(spans, index));
	if (lastNewline > start) return lastNewline;
	if (lastWhitespace > start) return lastWhitespace;
	return -1;
}
function scanParenAwareBreakpoints(text, start, end, isAllowed = () => true) {
	let lastNewline = -1;
	let lastWhitespace = -1;
	let depth = 0;
	for (let i = start; i < end; i++) {
		if (!isAllowed(i)) continue;
		const char = text[i];
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")" && depth > 0) {
			depth -= 1;
			continue;
		}
		if (depth !== 0) continue;
		if (char === "\n") lastNewline = i;
		else if (/\s/.test(char)) lastWhitespace = i;
	}
	return {
		lastNewline,
		lastWhitespace
	};
}
//#endregion
export { chunkText as a, resolveTextChunkLimit as c, chunkMarkdownTextWithMode as i, chunkTextByBreakResolver as l, chunkByParagraph as n, chunkTextWithMode as o, chunkMarkdownText as r, resolveChunkMode as s, chunkByNewline as t };
