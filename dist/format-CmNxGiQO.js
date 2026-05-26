import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as markdownToIR } from "./tables-D3y68tNR.js";
import { r as renderMarkdownIRChunksWithinLimit } from "./chunk-items-4pJLz72Q.js";
import "./text-chunking-C154U6-i.js";
//#region extensions/signal/src/format.ts
function normalizeUrlForComparison(url) {
	let normalized = normalizeLowercaseStringOrEmpty(url);
	normalized = normalized.replace(/^https?:\/\//, "");
	normalized = normalized.replace(/^www\./, "");
	normalized = normalized.replace(/\/+$/, "");
	return normalized;
}
function mapStyle(style) {
	switch (style) {
		case "bold": return "BOLD";
		case "italic": return "ITALIC";
		case "strikethrough": return "STRIKETHROUGH";
		case "code":
		case "code_block": return "MONOSPACE";
		case "spoiler": return "SPOILER";
		default: return null;
	}
}
function mergeStyles(styles) {
	const sorted = [...styles].toSorted((a, b) => {
		if (a.start !== b.start) return a.start - b.start;
		if (a.length !== b.length) return a.length - b.length;
		return a.style.localeCompare(b.style);
	});
	const merged = [];
	for (const style of sorted) {
		const prev = merged[merged.length - 1];
		if (prev && prev.style === style.style && style.start <= prev.start + prev.length) {
			const prevEnd = prev.start + prev.length;
			prev.length = Math.max(prevEnd, style.start + style.length) - prev.start;
			continue;
		}
		merged.push({ ...style });
	}
	return merged;
}
function clampStyles(styles, maxLength) {
	const clamped = [];
	for (const style of styles) {
		const start = Math.max(0, Math.min(style.start, maxLength));
		const length = Math.min(style.start + style.length, maxLength) - start;
		if (length > 0) clamped.push({
			start,
			length,
			style: style.style
		});
	}
	return clamped;
}
function applyInsertionsToStyles(spans, insertions) {
	if (insertions.length === 0) return spans;
	const sortedInsertions = [...insertions].toSorted((a, b) => a.pos - b.pos);
	let updated = spans;
	let cumulativeShift = 0;
	for (const insertion of sortedInsertions) {
		const insertionPos = insertion.pos + cumulativeShift;
		const next = [];
		for (const span of updated) {
			if (span.end <= insertionPos) {
				next.push(span);
				continue;
			}
			if (span.start >= insertionPos) {
				next.push({
					start: span.start + insertion.length,
					end: span.end + insertion.length,
					style: span.style
				});
				continue;
			}
			if (span.start < insertionPos && span.end > insertionPos) {
				if (insertionPos > span.start) next.push({
					start: span.start,
					end: insertionPos,
					style: span.style
				});
				const shiftedStart = insertionPos + insertion.length;
				const shiftedEnd = span.end + insertion.length;
				if (shiftedEnd > shiftedStart) next.push({
					start: shiftedStart,
					end: shiftedEnd,
					style: span.style
				});
			}
		}
		updated = next;
		cumulativeShift += insertion.length;
	}
	return updated;
}
function renderSignalText(ir) {
	const text = ir.text ?? "";
	if (!text) return {
		text: "",
		styles: []
	};
	const sortedLinks = [...ir.links].toSorted((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	const insertions = [];
	for (const link of sortedLinks) {
		if (link.start < cursor) continue;
		out += text.slice(cursor, link.end);
		const href = link.href.trim();
		const trimmedLabel = text.slice(link.start, link.end).trim();
		if (href) if (!trimmedLabel) {
			out += href;
			insertions.push({
				pos: link.end,
				length: href.length
			});
		} else {
			const normalizedLabel = normalizeUrlForComparison(trimmedLabel);
			let comparableHref = href;
			if (href.startsWith("mailto:")) comparableHref = href.slice(7);
			if (normalizedLabel !== normalizeUrlForComparison(comparableHref)) {
				const addition = ` (${href})`;
				out += addition;
				insertions.push({
					pos: link.end,
					length: addition.length
				});
			}
		}
		cursor = link.end;
	}
	out += text.slice(cursor);
	const adjusted = applyInsertionsToStyles(ir.styles.map((span) => {
		const mapped = mapStyle(span.style);
		if (!mapped) return null;
		return {
			start: span.start,
			end: span.end,
			style: mapped
		};
	}).filter((span) => span !== null), insertions);
	const trimmedText = out.trimEnd();
	const trimmedLength = trimmedText.length;
	return {
		text: trimmedText,
		styles: mergeStyles(clampStyles(adjusted.map((span) => ({
			start: span.start,
			length: span.end - span.start,
			style: span.style
		})), trimmedLength))
	};
}
function markdownToSignalText(markdown, options = {}) {
	return renderSignalText(markdownToIR(markdown ?? "", {
		linkify: true,
		enableSpoilers: true,
		headingStyle: "bold",
		blockquotePrefix: "> ",
		tableMode: options.tableMode
	}));
}
function markdownToSignalTextChunks(markdown, limit, options = {}) {
	return renderMarkdownIRChunksWithinLimit({
		ir: markdownToIR(markdown ?? "", {
			linkify: true,
			enableSpoilers: true,
			headingStyle: "bold",
			blockquotePrefix: "> ",
			tableMode: options.tableMode
		}),
		limit,
		renderChunk: renderSignalText,
		measureRendered: (rendered) => rendered.text.length
	}).map(({ rendered }) => rendered);
}
//#endregion
export { markdownToSignalTextChunks as n, markdownToSignalText as t };
