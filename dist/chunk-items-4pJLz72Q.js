import { o as sliceMarkdownIR, r as chunkMarkdownIR } from "./tables-D3y68tNR.js";
//#region src/markdown/render-aware-chunking.ts
function renderMarkdownIRChunksWithinLimit(options) {
	if (!options.ir.text) return [];
	const normalizedLimit = Math.max(1, Math.floor(options.limit));
	const pending = chunkMarkdownIR(options.ir, normalizedLimit);
	const finalized = [];
	while (pending.length > 0) {
		const chunk = pending.shift();
		if (!chunk) continue;
		const rendered = options.renderChunk(chunk);
		if (options.measureRendered(rendered) <= normalizedLimit || chunk.text.length <= 1) {
			finalized.push(chunk);
			continue;
		}
		const split = splitMarkdownIRByRenderedLimit(chunk, normalizedLimit, options);
		if (split.length <= 1) {
			finalized.push(chunk);
			continue;
		}
		pending.unshift(...split);
	}
	return coalesceWhitespaceOnlyMarkdownIRChunks(finalized, normalizedLimit, options).map((source) => ({
		source,
		rendered: options.renderChunk(source)
	}));
}
function splitMarkdownIRByRenderedLimit(chunk, renderedLimit, options) {
	const currentTextLength = chunk.text.length;
	if (currentTextLength <= 1) return [chunk];
	const splitLimit = findLargestChunkTextLengthWithinRenderedLimit(chunk, renderedLimit, options);
	if (splitLimit <= 0) return [chunk];
	const split = splitMarkdownIRPreserveWhitespace(chunk, splitLimit);
	const firstChunk = split[0];
	if (firstChunk && options.measureRendered(options.renderChunk(firstChunk)) <= renderedLimit) return split;
	return [sliceMarkdownIR(chunk, 0, splitLimit), sliceMarkdownIR(chunk, splitLimit, currentTextLength)];
}
function findLargestChunkTextLengthWithinRenderedLimit(chunk, renderedLimit, options) {
	const currentTextLength = chunk.text.length;
	if (currentTextLength <= 1) return currentTextLength;
	for (let candidateLength = currentTextLength - 1; candidateLength >= 1; candidateLength -= 1) {
		const candidate = sliceMarkdownIR(chunk, 0, candidateLength);
		const rendered = options.renderChunk(candidate);
		if (options.measureRendered(rendered) <= renderedLimit) return candidateLength;
	}
	return 0;
}
function findMarkdownIRPreservedSplitIndex(text, start, limit) {
	const maxEnd = Math.min(text.length, start + limit);
	if (maxEnd >= text.length) return text.length;
	let lastOutsideParenNewlineBreak = -1;
	let lastOutsideParenWhitespaceBreak = -1;
	let lastOutsideParenWhitespaceRunStart = -1;
	let lastAnyNewlineBreak = -1;
	let lastAnyWhitespaceBreak = -1;
	let lastAnyWhitespaceRunStart = -1;
	let parenDepth = 0;
	let sawNonWhitespace = false;
	for (let index = start; index < maxEnd; index += 1) {
		const char = text[index];
		if (char === "(") {
			sawNonWhitespace = true;
			parenDepth += 1;
			continue;
		}
		if (char === ")" && parenDepth > 0) {
			sawNonWhitespace = true;
			parenDepth -= 1;
			continue;
		}
		if (!/\s/.test(char)) {
			sawNonWhitespace = true;
			continue;
		}
		if (!sawNonWhitespace) continue;
		if (char === "\n") {
			lastAnyNewlineBreak = index + 1;
			if (parenDepth === 0) lastOutsideParenNewlineBreak = index + 1;
			continue;
		}
		const whitespaceRunStart = index === start || !/\s/.test(text[index - 1] ?? "") ? index : lastAnyWhitespaceRunStart;
		lastAnyWhitespaceBreak = index + 1;
		lastAnyWhitespaceRunStart = whitespaceRunStart;
		if (parenDepth === 0) {
			lastOutsideParenWhitespaceBreak = index + 1;
			lastOutsideParenWhitespaceRunStart = whitespaceRunStart;
		}
	}
	const resolveWhitespaceBreak = (breakIndex, runStart) => {
		if (breakIndex <= start) return breakIndex;
		if (runStart <= start) return breakIndex;
		return /\s/.test(text[breakIndex] ?? "") ? runStart : breakIndex;
	};
	if (lastOutsideParenNewlineBreak > start) return lastOutsideParenNewlineBreak;
	if (lastOutsideParenWhitespaceBreak > start) return resolveWhitespaceBreak(lastOutsideParenWhitespaceBreak, lastOutsideParenWhitespaceRunStart);
	if (lastAnyNewlineBreak > start) return lastAnyNewlineBreak;
	if (lastAnyWhitespaceBreak > start) return resolveWhitespaceBreak(lastAnyWhitespaceBreak, lastAnyWhitespaceRunStart);
	return maxEnd;
}
function splitMarkdownIRPreserveWhitespace(ir, limit) {
	if (!ir.text) return [];
	const normalizedLimit = Math.max(1, Math.floor(limit));
	if (normalizedLimit <= 0 || ir.text.length <= normalizedLimit) return [ir];
	const chunks = [];
	let cursor = 0;
	while (cursor < ir.text.length) {
		const end = findMarkdownIRPreservedSplitIndex(ir.text, cursor, normalizedLimit);
		chunks.push(sliceMarkdownIR(ir, cursor, end));
		cursor = end;
	}
	return chunks;
}
function mergeAdjacentStyleSpans(styles) {
	const merged = [];
	for (const span of styles) {
		const last = merged.at(-1);
		if (last && last.style === span.style && last.language === span.language && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}
function mergeAdjacentLinkSpans(links) {
	const merged = [];
	for (const link of links) {
		const last = merged.at(-1);
		if (last && last.href === link.href && link.start <= last.end) {
			last.end = Math.max(last.end, link.end);
			continue;
		}
		merged.push({ ...link });
	}
	return merged;
}
function mergeMarkdownIRChunks(left, right) {
	const offset = left.text.length;
	return {
		text: left.text + right.text,
		styles: mergeAdjacentStyleSpans([...left.styles, ...right.styles.map((span) => ({
			...span,
			start: span.start + offset,
			end: span.end + offset
		}))]),
		links: mergeAdjacentLinkSpans([...left.links, ...right.links.map((link) => ({
			...link,
			start: link.start + offset,
			end: link.end + offset
		}))])
	};
}
function coalesceWhitespaceOnlyMarkdownIRChunks(chunks, renderedLimit, options) {
	const coalesced = [];
	let index = 0;
	while (index < chunks.length) {
		const chunk = chunks[index];
		if (!chunk) {
			index += 1;
			continue;
		}
		if (chunk.text.trim().length > 0) {
			coalesced.push(chunk);
			index += 1;
			continue;
		}
		const prev = coalesced.at(-1);
		const next = chunks[index + 1];
		const chunkLength = chunk.text.length;
		const canMerge = (candidate) => options.measureRendered(options.renderChunk(candidate)) <= renderedLimit;
		if (prev) {
			const mergedPrev = mergeMarkdownIRChunks(prev, chunk);
			if (canMerge(mergedPrev)) {
				coalesced[coalesced.length - 1] = mergedPrev;
				index += 1;
				continue;
			}
		}
		if (next) {
			const mergedNext = mergeMarkdownIRChunks(chunk, next);
			if (canMerge(mergedNext)) {
				chunks[index + 1] = mergedNext;
				index += 1;
				continue;
			}
		}
		if (prev && next) for (let prefixLength = chunkLength - 1; prefixLength >= 1; prefixLength -= 1) {
			const prefix = sliceMarkdownIR(chunk, 0, prefixLength);
			const suffix = sliceMarkdownIR(chunk, prefixLength, chunkLength);
			const mergedPrev = mergeMarkdownIRChunks(prev, prefix);
			const mergedNext = mergeMarkdownIRChunks(suffix, next);
			if (canMerge(mergedPrev) && canMerge(mergedNext)) {
				coalesced[coalesced.length - 1] = mergedPrev;
				chunks[index + 1] = mergedNext;
				break;
			}
		}
		index += 1;
	}
	return coalesced;
}
//#endregion
//#region src/shared/text/strip-markdown.ts
/**
* Strip lightweight markdown formatting from text while preserving readable
* plain-text structure for TTS and channel fallbacks.
*/
function stripMarkdown(text) {
	let result = text;
	result = result.replace(/\*\*(.+?)\*\*/g, "$1");
	result = result.replace(/__(.+?)__/g, "$1");
	result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1");
	result = result.replace(/(?<![\p{L}\p{N}])_(?!_)(.+?)(?<!_)_(?![\p{L}\p{N}])/gu, "$1");
	result = result.replace(/~~(.+?)~~/g, "$1");
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "$1");
	result = result.replace(/^>\s?(.*)$/gm, "$1");
	result = result.replace(/^[-*_]{3,}$/gm, "");
	result = result.replace(/`([^`]+)`/g, "$1");
	result = result.replace(/\n{3,}/g, "\n\n");
	return result.trim();
}
//#endregion
//#region src/utils/chunk-items.ts
function chunkItems(items, size) {
	if (size <= 0) return [Array.from(items)];
	const rows = [];
	for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
	return rows;
}
//#endregion
export { stripMarkdown as n, renderMarkdownIRChunksWithinLimit as r, chunkItems as t };
