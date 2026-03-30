import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { h as normalizeAccountId } from "./session-key-qmb11-mH.js";
import { t as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-CJUwnCYd.js";
import { t as resolveAccountEntry } from "./account-lookup-DndUerpe.js";

//#region src/markdown/fences.ts
function parseFenceSpans(buffer) {
	const spans = [];
	let open;
	let offset = 0;
	while (offset <= buffer.length) {
		const nextNewline = buffer.indexOf("\n", offset);
		const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
		const line = buffer.slice(offset, lineEnd);
		const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
		if (match) {
			const indent = match[1];
			const marker = match[2];
			const markerChar = marker[0];
			const markerLen = marker.length;
			if (!open) open = {
				start: offset,
				markerChar,
				markerLen,
				openLine: line,
				marker,
				indent
			};
			else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
				const end = lineEnd;
				spans.push({
					start: open.start,
					end,
					openLine: open.openLine,
					marker: open.marker,
					indent: open.indent
				});
				open = void 0;
			}
		}
		if (nextNewline === -1) break;
		offset = nextNewline + 1;
	}
	if (open) spans.push({
		start: open.start,
		end: buffer.length,
		openLine: open.openLine,
		marker: open.marker,
		indent: open.indent
	});
	return spans;
}
function findFenceSpanAt(spans, index) {
	return spans.find((span) => index > span.start && index < span.end);
}
function isSafeFenceBreak(spans, index) {
	return !findFenceSpanAt(spans, index);
}

//#endregion
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
var chunk_exports = /* @__PURE__ */ __exportAll({
	chunkByNewline: () => chunkByNewline,
	chunkByParagraph: () => chunkByParagraph,
	chunkMarkdownText: () => chunkMarkdownText,
	chunkMarkdownTextWithMode: () => chunkMarkdownTextWithMode,
	chunkText: () => chunkText,
	chunkTextWithMode: () => chunkTextWithMode,
	resolveChunkMode: () => resolveChunkMode,
	resolveTextChunkLimit: () => resolveTextChunkLimit
});
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
		if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) return;
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
		const direct = resolveAccountEntry(accounts, normalizedAccountId);
		if (direct?.chunkMode) return direct.chunkMode;
	}
	return cfgSection.chunkMode;
}
function resolveChunkMode(cfg, provider, accountId) {
	if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) return DEFAULT_CHUNK_MODE;
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
		const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window);
		return lastNewline > 0 ? lastNewline : lastWhitespace;
	});
}
function chunkMarkdownText(text, limit) {
	const early = resolveChunkEarlyReturn(text, limit);
	if (early) return early;
	const chunks = [];
	let remaining = text;
	while (remaining.length > limit) {
		const spans = parseFenceSpans(remaining);
		const softBreak = pickSafeBreakIndex(remaining.slice(0, limit), spans);
		let breakIdx = softBreak > 0 ? softBreak : limit;
		const initialFence = isSafeFenceBreak(spans, breakIdx) ? void 0 : findFenceSpanAt(spans, breakIdx);
		let fenceToSplit = initialFence;
		if (initialFence) {
			const closeLine = `${initialFence.indent}${initialFence.marker}`;
			const maxIdxIfNeedNewline = limit - (closeLine.length + 1);
			if (maxIdxIfNeedNewline <= 0) {
				fenceToSplit = void 0;
				breakIdx = limit;
			} else {
				const minProgressIdx = Math.min(remaining.length, initialFence.start + initialFence.openLine.length + 2);
				const maxIdxIfAlreadyNewline = limit - closeLine.length;
				let pickedNewline = false;
				let lastNewline = remaining.lastIndexOf("\n", Math.max(0, maxIdxIfAlreadyNewline - 1));
				while (lastNewline !== -1) {
					const candidateBreak = lastNewline + 1;
					if (candidateBreak < minProgressIdx) break;
					const candidateFence = findFenceSpanAt(spans, candidateBreak);
					if (candidateFence && candidateFence.start === initialFence.start) {
						breakIdx = Math.max(1, candidateBreak);
						pickedNewline = true;
						break;
					}
					lastNewline = remaining.lastIndexOf("\n", lastNewline - 1);
				}
				if (!pickedNewline) if (minProgressIdx > maxIdxIfAlreadyNewline) {
					fenceToSplit = void 0;
					breakIdx = limit;
				} else breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
			}
			const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
			fenceToSplit = fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : void 0;
		}
		let rawChunk = remaining.slice(0, breakIdx);
		if (!rawChunk) break;
		const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
		const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
		let next = remaining.slice(nextStart);
		if (fenceToSplit) {
			const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
			rawChunk = rawChunk.endsWith("\n") ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
			next = `${fenceToSplit.openLine}\n${next}`;
		} else next = stripLeadingNewlines(next);
		chunks.push(rawChunk);
		remaining = next;
	}
	if (remaining.length) chunks.push(remaining);
	return chunks;
}
function stripLeadingNewlines(value) {
	let i = 0;
	while (i < value.length && value[i] === "\n") i++;
	return i > 0 ? value.slice(i) : value;
}
function pickSafeBreakIndex(window, spans) {
	const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, (index) => isSafeFenceBreak(spans, index));
	if (lastNewline > 0) return lastNewline;
	if (lastWhitespace > 0) return lastWhitespace;
	return -1;
}
function scanParenAwareBreakpoints(window, isAllowed = () => true) {
	let lastNewline = -1;
	let lastWhitespace = -1;
	let depth = 0;
	for (let i = 0; i < window.length; i++) {
		if (!isAllowed(i)) continue;
		const char = window[i];
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
export { chunkText as a, resolveChunkMode as c, isSafeFenceBreak as d, parseFenceSpans as f, chunkMarkdownTextWithMode as i, resolveTextChunkLimit as l, chunkByParagraph as n, chunkTextWithMode as o, chunkMarkdownText as r, chunk_exports as s, chunkByNewline as t, findFenceSpanAt as u };