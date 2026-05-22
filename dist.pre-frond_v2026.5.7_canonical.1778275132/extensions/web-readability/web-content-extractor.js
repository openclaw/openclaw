import { i as normalizeWhitespace, n as htmlToMarkdown, o as sanitizeHtml, s as stripInvisibleUnicode } from "../../web-fetch-utils-C2klyNbz.js";
//#region extensions/web-readability/web-content-extractor.ts
const READABILITY_MAX_HTML_CHARS = 1e6;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3e3;
const READABILITY_MODULE = "@mozilla/readability";
const LINKEDOM_MODULE = "linkedom";
let readabilityDepsPromise;
async function loadReadabilityDeps() {
	if (!readabilityDepsPromise) readabilityDepsPromise = Promise.all([import(READABILITY_MODULE), import(LINKEDOM_MODULE)]).then(([readability, linkedom]) => ({
		Readability: readability.Readability,
		parseHTML: linkedom.parseHTML
	}));
	try {
		return await readabilityDepsPromise;
	} catch (error) {
		readabilityDepsPromise = void 0;
		throw error;
	}
}
function normalizeLowercaseStringOrEmpty(value) {
	return value.trim().toLowerCase();
}
function exceedsEstimatedHtmlNestingDepth(html, maxDepth) {
	const voidTags = new Set([
		"area",
		"base",
		"br",
		"col",
		"embed",
		"hr",
		"img",
		"input",
		"link",
		"meta",
		"param",
		"source",
		"track",
		"wbr"
	]);
	let depth = 0;
	const len = html.length;
	for (let i = 0; i < len; i++) {
		if (html.charCodeAt(i) !== 60) continue;
		const next = html.charCodeAt(i + 1);
		if (next === 33 || next === 63) continue;
		let j = i + 1;
		let closing = false;
		if (html.charCodeAt(j) === 47) {
			closing = true;
			j += 1;
		}
		while (j < len && html.charCodeAt(j) <= 32) j += 1;
		const nameStart = j;
		while (j < len) {
			const c = html.charCodeAt(j);
			if (!(c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 58 || c === 45)) break;
			j += 1;
		}
		const tagName = normalizeLowercaseStringOrEmpty(html.slice(nameStart, j));
		if (!tagName) continue;
		if (closing) {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (voidTags.has(tagName)) continue;
		let selfClosing = false;
		for (let k = j; k < len && k < j + 200; k++) if (html.charCodeAt(k) === 62) {
			selfClosing = html.charCodeAt(k - 1) === 47;
			break;
		}
		if (selfClosing) continue;
		depth += 1;
		if (depth > maxDepth) return true;
	}
	return false;
}
async function extractWithReadability(request) {
	const cleanHtml = await sanitizeHtml(request.html);
	if (cleanHtml.length > READABILITY_MAX_HTML_CHARS || exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)) return null;
	try {
		const { Readability, parseHTML } = await loadReadabilityDeps();
		const { document } = parseHTML(cleanHtml);
		try {
			document.baseURI = request.url;
		} catch {}
		const parsed = new Readability(document, { charThreshold: 0 }).parse();
		if (!parsed?.content) return null;
		const title = parsed.title || void 0;
		if (request.extractMode === "text") {
			const text = stripInvisibleUnicode(normalizeWhitespace(parsed.textContent ?? ""));
			return text ? {
				text,
				title
			} : null;
		}
		const rendered = htmlToMarkdown(parsed.content);
		const text = stripInvisibleUnicode(rendered.text);
		return text ? {
			text,
			title: title ?? rendered.title
		} : null;
	} catch {
		return null;
	}
}
function createReadabilityWebContentExtractor() {
	return {
		id: "readability",
		label: "Readability",
		autoDetectOrder: 10,
		extract: extractWithReadability
	};
}
//#endregion
export { createReadabilityWebContentExtractor };
