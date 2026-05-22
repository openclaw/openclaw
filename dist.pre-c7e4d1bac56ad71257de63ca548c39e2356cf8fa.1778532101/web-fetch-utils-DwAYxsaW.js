import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/tools/web-fetch-visibility.ts
const HIDDEN_STYLE_PATTERNS = [
	["display", /^\s*none\s*$/i],
	["visibility", /^\s*hidden\s*$/i],
	["opacity", /^\s*0\s*$/],
	["font-size", /^\s*0(px|em|rem|pt|%)?\s*$/i],
	["text-indent", /^\s*-\d{4,}px\s*$/],
	["color", /^\s*transparent\s*$/i],
	["color", /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
	["color", /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i]
];
const HIDDEN_CLASS_NAMES = new Set([
	"sr-only",
	"visually-hidden",
	"d-none",
	"hidden",
	"invisible",
	"screen-reader-only",
	"offscreen"
]);
const HTML_VOID_ELEMENTS = new Set([
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
function hasHiddenClass(className) {
	return normalizeLowercaseStringOrEmpty(className).split(/\s+/).some((cls) => HIDDEN_CLASS_NAMES.has(cls));
}
function isStyleHidden(style) {
	for (const [prop, pattern] of HIDDEN_STYLE_PATTERNS) {
		const escapedProp = prop.replace(/-/g, "\\-");
		const match = style.match(new RegExp(`(?:^|;)\\s*${escapedProp}\\s*:\\s*([^;]+)`, "i"));
		if (match && pattern.test(match[1])) return true;
	}
	const clipPath = style.match(/(?:^|;)\s*clip-path\s*:\s*([^;]+)/i);
	if (clipPath && !/^\s*none\s*$/i.test(clipPath[1])) {
		if (/inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPath[1])) return true;
	}
	const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i);
	if (transform) {
		if (/scale\s*\(\s*0\s*\)/i.test(transform[1])) return true;
		if (/translateX\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) return true;
		if (/translateY\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) return true;
	}
	const width = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
	const height = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i);
	const overflow = style.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i);
	if (width && /^\s*0(px)?\s*$/i.test(width[1]) && height && /^\s*0(px)?\s*$/i.test(height[1]) && overflow && /^\s*hidden\s*$/i.test(overflow[1])) return true;
	const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i);
	const top = style.match(/(?:^|;)\s*top\s*:\s*([^;]+)/i);
	if (left && /^\s*-\d{4,}px\s*$/i.test(left[1])) return true;
	if (top && /^\s*-\d{4,}px\s*$/i.test(top[1])) return true;
	return false;
}
function readAttribute(attrs, name) {
	const escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
	const match = attrs.match(new RegExp(`(?:^|\\s)${escapedName}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+)))?`, "i"));
	if (!match) return;
	return match[1] ?? match[2] ?? match[3] ?? "";
}
function hasAttribute(attrs, name) {
	return readAttribute(attrs, name) !== void 0;
}
function shouldRemoveElement(tagNameRaw, attrs) {
	const tagName = normalizeLowercaseStringOrEmpty(tagNameRaw);
	if ([
		"meta",
		"template",
		"svg",
		"canvas",
		"iframe",
		"object",
		"embed"
	].includes(tagName)) return true;
	if (tagName === "input" && normalizeOptionalLowercaseString(readAttribute(attrs, "type")) === "hidden") return true;
	if (normalizeOptionalLowercaseString(readAttribute(attrs, "aria-hidden")) === "true") return true;
	if (hasAttribute(attrs, "hidden")) return true;
	if (hasHiddenClass(readAttribute(attrs, "class") ?? "")) return true;
	const style = readAttribute(attrs, "style") ?? "";
	if (style && isStyleHidden(style)) return true;
	return false;
}
function findTagEnd(html, start) {
	let quote;
	for (let index = start + 1; index < html.length; index += 1) {
		const char = html[index];
		if (quote) {
			if (char === quote) quote = void 0;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return index;
	}
	return -1;
}
function readTagName(source, start) {
	let end = start;
	while (end < source.length) {
		const code = source.charCodeAt(end);
		if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || source[end] === "-" || source[end] === "_" || source[end] === ":")) break;
		end += 1;
	}
	if (end === start) return null;
	return {
		tagName: normalizeLowercaseStringOrEmpty(source.slice(start, end)),
		end
	};
}
function parseHtmlTagToken(token) {
	let inner = token.slice(1, -1).trim();
	if (!inner || inner.startsWith("!") || inner.startsWith("?")) return null;
	const closing = inner.startsWith("/");
	if (closing) inner = inner.slice(1).trimStart();
	const name = readTagName(inner, 0);
	if (!name) return null;
	const attrs = closing ? "" : inner.slice(name.end);
	return {
		tagName: name.tagName,
		attrs,
		closing,
		selfClosing: !closing && attrs.trimEnd().endsWith("/")
	};
}
function popDroppedElement(dropStack, tagName) {
	const index = dropStack.lastIndexOf(tagName);
	if (index >= 0) dropStack.length = index;
}
function removeMarkedElements(html) {
	let output = "";
	let cursor = 0;
	const dropStack = [];
	while (cursor < html.length) {
		const tagStart = html.indexOf("<", cursor);
		if (tagStart < 0) {
			if (dropStack.length === 0) output += html.slice(cursor);
			break;
		}
		if (dropStack.length === 0) output += html.slice(cursor, tagStart);
		if (html.startsWith("<!--", tagStart)) {
			const commentEnd = html.indexOf("-->", tagStart + 4);
			cursor = commentEnd < 0 ? html.length : commentEnd + 3;
			continue;
		}
		const tagEnd = findTagEnd(html, tagStart);
		if (tagEnd < 0) {
			if (dropStack.length === 0) output += html.slice(tagStart);
			break;
		}
		const token = html.slice(tagStart, tagEnd + 1);
		const parsed = parseHtmlTagToken(token);
		if (!parsed) {
			if (dropStack.length === 0) output += token;
			cursor = tagEnd + 1;
			continue;
		}
		if (dropStack.length > 0) {
			if (parsed.closing) popDroppedElement(dropStack, parsed.tagName);
			else if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.tagName)) dropStack.push(parsed.tagName);
			cursor = tagEnd + 1;
			continue;
		}
		if (parsed.closing) output += token;
		else if (shouldRemoveElement(parsed.tagName, parsed.attrs)) {
			if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.tagName)) dropStack.push(parsed.tagName);
		} else output += token;
		cursor = tagEnd + 1;
	}
	return output;
}
async function sanitizeHtml(html) {
	return removeMarkedElements(html);
}
const INVISIBLE_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;
function stripInvisibleUnicode(text) {
	return text.replace(INVISIBLE_UNICODE_RE, "");
}
//#endregion
//#region src/agents/tools/web-fetch-utils.ts
function decodeEntities(value) {
	return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}
function stripTags(value) {
	return decodeEntities(value.replace(/<[^>]+>/g, ""));
}
function normalizeWhitespace(value) {
	return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
function htmlToMarkdown(html) {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : void 0;
	let text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
		const label = normalizeWhitespace(stripTags(body));
		if (!label) return href;
		return `[${label}](${href})`;
	});
	text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
		return `\n${"#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))))} ${normalizeWhitespace(stripTags(body))}\n`;
	});
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
		const label = normalizeWhitespace(stripTags(body));
		return label ? `\n- ${label}` : "";
	});
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n").replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
	text = stripTags(text);
	text = normalizeWhitespace(text);
	return {
		text,
		title
	};
}
function markdownToText(markdown) {
	let text = markdown;
	text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
	text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
	text = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""));
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/^#{1,6}\s+/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\d+\.\s+/gm, "");
	return normalizeWhitespace(text);
}
function truncateText(value, maxChars) {
	if (value.length <= maxChars) return {
		text: value,
		truncated: false
	};
	return {
		text: value.slice(0, maxChars),
		truncated: true
	};
}
async function extractBasicHtmlContent(params) {
	const cleanHtml = await sanitizeHtml(params.html);
	const rendered = htmlToMarkdown(cleanHtml);
	if (params.extractMode === "text") {
		const text = stripInvisibleUnicode(markdownToText(rendered.text)) || stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)));
		return text ? {
			text,
			title: rendered.title
		} : null;
	}
	const text = stripInvisibleUnicode(rendered.text);
	return text ? {
		text,
		title: rendered.title
	} : null;
}
//#endregion
export { truncateText as a, normalizeWhitespace as i, htmlToMarkdown as n, sanitizeHtml as o, markdownToText as r, stripInvisibleUnicode as s, extractBasicHtmlContent as t };
