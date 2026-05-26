import { promises } from "node:fs";
import { resolve } from "node:path";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import MarkdownIt from "markdown-it";
//#region extensions/oc-path/src/oc-path/sentinel.ts
/**
* Redaction-sentinel guard. Throws at emit boundaries so every write
* path is covered, not just audited consumers.
*
* @module @openclaw/oc-path/sentinel
*/
/** Literal marking a redacted secret. Writing it to disk is always a bug. */
const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
/**
* Thrown when emit detects the sentinel in output bytes. Fail-closed:
* stripping would silently corrupt the file. `path` is the closest
* OcPath-shaped pointer to the violation.
*/
var OcEmitSentinelError = class extends Error {
	constructor(path) {
		super(`emit refused to write "${REDACTED_SENTINEL}" sentinel literal at ${path}`);
		this.code = "OC_EMIT_SENTINEL";
		this.name = "OcEmitSentinelError";
		this.path = path;
	}
};
function guardSentinel$1(value, ocPath) {
	if (typeof value === "string" && value.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(ocPath);
}
//#endregion
//#region extensions/oc-path/src/oc-path/oc-path.ts
/**
* `oc://` path syntax — universal addressing for the OpenClaw workspace.
*
*     oc://{file}[/{section}[/{item}[/{field}]]][?session={id}]
*
* Canonical round-trip contract: `formatOcPath(parseOcPath(s)) === s`
* for canonical paths. Extra query parameters are ignored except for
* the first non-empty `session=` value.
*
* @module @openclaw/oc-path/oc-path
*/
const OC_SCHEME = "oc://";
const MAX_PATH_LENGTH = 4096;
const BOM$1 = "﻿";
function hasControlChar(s) {
	for (let i = 0; i < s.length; i++) {
		const cc = s.charCodeAt(i);
		if (cc <= 31 || cc === 127) return true;
	}
	return false;
}
const RESERVED_CHARS_RE = /[?&%]/;
/** Render with `\xNN` escapes so error output is readable for invisible chars. */
function printable(s) {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const cc = s.charCodeAt(i);
		if (cc <= 31 || cc === 127) out += `\\x${cc.toString(16).padStart(2, "0")}`;
		else out += s[i];
	}
	return out;
}
/** `code` is the stable machine-readable tag; consumers match on `code`, not `message`. */
var OcPathError = class extends Error {
	constructor(message, input, code) {
		super(message);
		this.name = "OcPathError";
		this.input = input;
		this.code = code;
	}
};
function fail(message, input, code) {
	throw new OcPathError(message, input, code);
}
function validateFileSlot(file, contextInput) {
	if (file.startsWith("/") || file.startsWith("\\") || /^[a-zA-Z]:/.test(file)) fail(`Absolute file slot not allowed (oc:// paths are workspace-relative): ${printable(contextInput)}`, contextInput, "OC_PATH_ABSOLUTE_FILE");
	if (file.split(/[\\/]/).some((seg) => seg === "..")) fail(`Parent-directory segment ('..') not allowed in oc:// file slot: ${printable(contextInput)}`, contextInput, "OC_PATH_PARENT_TRAVERSAL");
	if (hasControlChar(file)) fail(`Control character in oc:// file slot: ${printable(contextInput)}`, contextInput, "OC_PATH_CONTROL_CHAR");
}
function validateSessionSlot(session, contextInput) {
	if (hasControlChar(session)) fail(`Control character in oc:// session query: ${printable(contextInput)}`, contextInput, "OC_PATH_CONTROL_CHAR");
	if (RESERVED_CHARS_RE.test(session)) fail(`Reserved character (\`?\` / \`&\` / \`%\`) in oc:// session query: ${printable(contextInput)}`, contextInput, "OC_PATH_RESERVED_CHAR");
}
/** Parse an `oc://` path string into a structured `OcPath`. */
function parseOcPath(input) {
	if (typeof input !== "string") fail("oc:// path must be a string", String(input), "OC_PATH_NOT_STRING");
	if (input.length > 4096) fail(`oc:// path exceeds ${MAX_PATH_LENGTH} bytes (length: ${input.length})`, input.slice(0, 80) + "…", "OC_PATH_TOO_LONG");
	let normalized = input.startsWith(BOM$1) ? input.slice(1) : input;
	normalized = normalized.normalize("NFC");
	if (normalized.length > 4096) fail(`oc:// path exceeds ${MAX_PATH_LENGTH} bytes after NFC (length: ${normalized.length})`, input.slice(0, 80) + "…", "OC_PATH_TOO_LONG");
	if (!normalized.startsWith(OC_SCHEME)) fail(`Missing oc:// scheme: ${printable(input)}`, input, "OC_PATH_MISSING_SCHEME");
	if (hasControlChar(normalized)) fail(`Control character in oc:// path: ${printable(input)}`, input, "OC_PATH_CONTROL_CHAR");
	const afterScheme = normalized.slice(5);
	const queryIndex = indexOfTopLevel(afterScheme, "?");
	const pathPart = queryIndex === -1 ? afterScheme : afterScheme.slice(0, queryIndex);
	const queryPart = queryIndex === -1 ? "" : afterScheme.slice(queryIndex + 1);
	if (pathPart.length === 0) fail(`Empty oc:// path: ${printable(input)}`, input, "OC_PATH_EMPTY");
	const segments = splitRespectingBrackets(pathPart, "/", input);
	for (const seg of segments) if (seg.length === 0) fail(`Empty segment in oc:// path: ${printable(input)}`, input, "OC_PATH_EMPTY_SEGMENT");
	if (segments.length > 4) fail(`Too many segments in oc:// path (max 4): ${printable(input)}`, input, "OC_PATH_TOO_DEEP");
	for (const seg of segments) {
		validateBrackets(seg, input);
		const subs = splitRespectingBrackets(seg, ".", input);
		if (subs.length > 64) fail(`Sub-segment count exceeds 64 in segment "${seg}": ${printable(input)}`, input, "OC_PATH_TOO_DEEP");
		for (const sub of subs) validateSubSegment(sub, input);
	}
	const fileSeg = segments[0];
	const file = isQuotedSeg(fileSeg) ? unquoteSeg(fileSeg) : fileSeg;
	validateFileSlot(file, input);
	const session = extractSession(queryPart, input);
	return {
		file,
		...segments[1] !== void 0 ? { section: segments[1] } : {},
		...segments[2] !== void 0 ? { item: segments[2] } : {},
		...segments[3] !== void 0 ? { field: segments[3] } : {},
		...session !== void 0 ? { session } : {}
	};
}
/** Format an `OcPath` struct into its canonical string form. */
function formatOcPath(path) {
	if (!path.file || path.file.length === 0) fail("oc:// path requires a file", "", "OC_PATH_FILE_REQUIRED");
	validateFileSlot(path.file, path.file);
	if (path.item !== void 0 && path.section === void 0) fail("Structural nesting violation: item requires section", path.file, "OC_PATH_NESTING");
	if (path.field !== void 0 && path.item === void 0) fail("Structural nesting violation: field requires item", path.file, "OC_PATH_NESTING");
	const formatSubSegment = (sub) => {
		if (isQuotedSeg(sub)) return sub;
		if (sub.startsWith("[") && sub.endsWith("]")) return sub;
		if (sub.startsWith("{") && sub.endsWith("}")) return sub;
		return quoteSeg(sub);
	};
	const validateSubForFormat = (sub, slotName) => {
		if (sub.length === 0) fail(`Empty dotted sub-segment in OcPath.${slotName}`, path.file, "OC_PATH_EMPTY_SUB_SEGMENT");
		if (hasControlChar(sub)) fail(`Control character in OcPath.${slotName} sub-segment "${printable(sub)}"`, path.file, "OC_PATH_CONTROL_CHAR");
	};
	const formatSlot = (slot, slotName) => {
		const subs = splitRespectingBrackets(slot, ".");
		for (const sub of subs) validateSubForFormat(sub, slotName);
		return subs.map(formatSubSegment).join(".");
	};
	let out = OC_SCHEME + (/[/[\]{}?&%"\s]/.test(path.file) ? quoteSeg(path.file) : path.file);
	if (path.section !== void 0) out += "/" + formatSlot(path.section, "section");
	if (path.item !== void 0) out += "/" + formatSlot(path.item, "item");
	if (path.field !== void 0) out += "/" + formatSlot(path.field, "field");
	if (path.session !== void 0) {
		validateSessionSlot(path.session, path.file);
		out += "?session=" + path.session;
	}
	if (out.length > 4096) fail(`Formatted oc:// exceeds ${MAX_PATH_LENGTH} bytes (length: ${out.length})`, out.slice(0, 80) + "…", "OC_PATH_TOO_LONG");
	if (out.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(out);
	return out;
}
function isPositionalSeg(seg) {
	return seg === "$first" || seg === "$last";
}
/**
* Ordinal addressing — `#N` targets the Nth item by document order.
* Earns its keep on slug-addressed kinds (md items can share a slug
* via `- foo: a` / `- foo: b`); `#0`/`#1` distinguish them.
*/
function isOrdinalSeg(seg) {
	return /^#\d+$/.test(seg);
}
function parseOrdinalSeg(seg) {
	const m = /^#(\d+)$/.exec(seg);
	return m === null || m[1] === void 0 ? null : Number(m[1]);
}
function resolvePositionalSeg(seg, container) {
	if (container.size === 0) return null;
	if (seg === "$first") {
		if (!container.indexable) return container.keys?.[0] ?? null;
		return "0";
	}
	if (seg === "$last") {
		if (!container.indexable) return container.keys?.[container.keys.length - 1] ?? null;
		return String(container.size - 1);
	}
	return null;
}
/**
* True iff any sub-segment is a multi-match pattern (`*`, `**`,
* union `{a,b,c}`, or predicate `[k=v]`). Single-match verbs reject
* these; only `findOcPaths` consumes them.
*/
function isPattern(path) {
	for (const slot of [
		path.section,
		path.item,
		path.field
	]) {
		if (slot === void 0) continue;
		for (const sub of splitRespectingBrackets(slot, ".")) {
			if (sub === "*" || sub === "**") return true;
			if (isUnionSeg(sub)) return true;
			if (isPredicateSeg(sub)) return true;
		}
	}
	return false;
}
/** @deprecated v1 — use {@link isPattern}. Behaviorally identical. */
const hasWildcard = isPattern;
/** Union segment `{a,b,c}` matches each comma-separated alternative. */
function isUnionSeg(seg) {
	return seg.length >= 2 && seg.startsWith("{") && seg.endsWith("}");
}
function parseUnionSeg(seg) {
	if (!isUnionSeg(seg)) return null;
	const inner = seg.slice(1, -1);
	if (inner.length === 0) return null;
	const alts = inner.split(",");
	if (alts.some((a) => a.length === 0)) return null;
	return alts;
}
const PREDICATE_OPS = [
	"!=",
	"<=",
	">=",
	"<",
	">",
	"="
];
function isPredicateSeg(seg) {
	if (seg.length < 4 || !seg.startsWith("[") || !seg.endsWith("]")) return false;
	const inner = new Set(seg.slice(1, -1));
	return PREDICATE_OPS.some((op) => inner.has(op));
}
function parsePredicateSeg(seg) {
	if (seg.length < 4 || !seg.startsWith("[") || !seg.endsWith("]")) return null;
	const inner = seg.slice(1, -1);
	for (let i = 1; i < inner.length; i++) for (const op of PREDICATE_OPS) {
		if (!inner.startsWith(op, i)) continue;
		if (i + op.length >= inner.length) continue;
		return {
			key: inner.slice(0, i),
			op,
			value: inner.slice(i + op.length)
		};
	}
	return null;
}
function evaluatePredicate(actual, pred) {
	if (actual === null) return false;
	switch (pred.op) {
		case "=": return actual === pred.value;
		case "!=": return actual !== pred.value;
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const a = Number(actual);
			const b = Number(pred.value);
			if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
			if (pred.op === "<") return a < b;
			if (pred.op === "<=") return a <= b;
			if (pred.op === ">") return a > b;
			return a >= b;
		}
	}
	return false;
}
function extractSession(queryPart, input) {
	if (queryPart.length === 0) return;
	for (const pair of queryPart.split("&")) {
		const eqIndex = pair.indexOf("=");
		if (eqIndex === -1) continue;
		const key = pair.slice(0, eqIndex);
		const value = pair.slice(eqIndex + 1);
		if (key === "session" && value.length > 0) {
			validateSessionSlot(value, input);
			return value;
		}
	}
}
function scanBracketAware(s, onChar, onUnbalanced) {
	let depthBracket = 0;
	let depthBrace = 0;
	let inQuote = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inQuote) {
			if (c === "\"") inQuote = false;
			if (onChar(c, i, false) === "stop") return;
			continue;
		}
		if (c === "\"") {
			inQuote = true;
			if (onChar(c, i, false) === "stop") return;
			continue;
		}
		if (c === "[") depthBracket++;
		else if (c === "]") depthBracket--;
		else if (c === "{") depthBrace++;
		else if (c === "}") depthBrace--;
		if (depthBracket < 0 || depthBrace < 0) onUnbalanced();
		if (onChar(c, i, depthBracket === 0 && depthBrace === 0) === "stop") return;
	}
	if (depthBracket !== 0 || depthBrace !== 0 || inQuote) onUnbalanced();
}
/** First top-level occurrence of `ch` in `s`; -1 when absent. */
function indexOfTopLevel(s, ch) {
	let result = -1;
	const fail = () => {
		throw new OcPathError(`Unbalanced bracket/brace in oc:// path: ${s}`, s, "OC_PATH_UNBALANCED");
	};
	scanBracketAware(s, (c, i, atTop) => {
		if (atTop && c === ch) {
			result = i;
			return "stop";
		}
	}, fail);
	return result;
}
function splitRespectingBrackets(s, delim, originalInput) {
	const out = [];
	let buf = "";
	const ctx = originalInput ?? s;
	const onUnbalanced = () => {
		fail(`Unbalanced bracket/brace in oc:// path: ${ctx}`, ctx, "OC_PATH_UNBALANCED");
	};
	scanBracketAware(s, (c, _i, atTop) => {
		if (atTop && c === delim) {
			out.push(buf);
			buf = "";
			return;
		}
		buf += c;
	}, onUnbalanced);
	out.push(buf);
	return out;
}
/** True iff `seg` is `"..."`. */
function isQuotedSeg(seg) {
	return seg.length >= 2 && seg.startsWith("\"") && seg.endsWith("\"");
}
/** Strip surrounding quotes. Content is byte-literal. */
function unquoteSeg(seg) {
	return isQuotedSeg(seg) ? seg.slice(1, -1) : seg;
}
function quoteSeg(value) {
	if (value.length === 0) return "\"\"";
	if (value.includes("\"") || value.includes("\\")) fail(`Cannot quote value containing '"' or '\\\\': ${printable(value)}`, value, "OC_PATH_UNQUOTABLE");
	return /[/.[\]{}?&%\s]/.test(value) ? `"${value}"` : value;
}
function validateBrackets(seg, input) {
	scanBracketAware(seg, () => void 0, () => {
		fail(`Unbalanced bracket/brace in segment "${seg}": ${printable(input)}`, input, "OC_PATH_UNBALANCED");
	});
}
function validateSubSegment(sub, input) {
	if (sub.length === 0) fail(`Empty dotted sub-segment in oc:// path: ${printable(input)}`, input, "OC_PATH_EMPTY_SUB_SEGMENT");
	if (hasControlChar(sub)) fail(`Control character in oc:// segment "${printable(sub)}": ${printable(input)}`, input, "OC_PATH_CONTROL_CHAR");
	if (isQuotedSeg(sub)) {
		const inner = new Set(sub.slice(1, -1));
		if (inner.has("\"") || inner.has("\\")) fail(`Quoted segment cannot contain '"' or '\\\\': ${printable(sub)}`, input, "OC_PATH_UNQUOTABLE");
		return;
	}
	if (!sub.startsWith("[") && !sub.startsWith("{")) {
		if (RESERVED_CHARS_RE.test(sub)) fail(`Reserved character (\`?\` / \`&\` / \`%\`) in oc:// segment "${sub}": ${printable(input)}`, input, "OC_PATH_RESERVED_CHAR");
		if (sub !== sub.trim() || /\s/.test(sub)) fail(`Whitespace in oc:// segment "${sub}": ${printable(input)}`, input, "OC_PATH_WHITESPACE");
	}
	const startsBracket = sub.startsWith("[");
	const endsBracket = sub.endsWith("]");
	if (startsBracket !== endsBracket) fail(`Mismatched bracket in segment "${sub}": ${printable(input)}`, input, "OC_PATH_MALFORMED_PREDICATE");
	if (startsBracket && endsBracket) {
		const inner = sub.slice(1, -1);
		if (inner.length === 0) fail(`Empty bracket segment "${sub}": ${printable(input)}`, input, "OC_PATH_MALFORMED_PREDICATE");
		if ([
			"!=",
			"<=",
			">=",
			"<",
			">",
			"="
		].some((op) => inner.includes(op))) {
			const parsed = parsePredicateSeg(sub);
			if (parsed === null || parsed.key.length === 0 || parsed.value.length === 0) fail(`Malformed predicate "${sub}" — must be \`[key<op>value]\` with non-empty key and value: ${printable(input)}`, input, "OC_PATH_MALFORMED_PREDICATE");
		}
	}
	const startsBrace = sub.startsWith("{");
	const endsBrace = sub.endsWith("}");
	if (startsBrace !== endsBrace) fail(`Mismatched brace in segment "${sub}": ${printable(input)}`, input, "OC_PATH_MALFORMED_UNION");
	if (startsBrace && endsBrace) {
		const inner = sub.slice(1, -1);
		if (inner.length === 0) fail(`Empty union "${sub}" — must contain at least one alternative: ${printable(input)}`, input, "OC_PATH_MALFORMED_UNION");
		if (inner.split(",").some((a) => a.length === 0)) fail(`Empty alternative in union "${sub}": ${printable(input)}`, input, "OC_PATH_MALFORMED_UNION");
	}
}
//#endregion
//#region extensions/oc-path/src/oc-path/slug.ts
/**
* Slug derivation: kebab-case lowercase, deterministic, idempotent.
* Used by parse + resolve for section/item addressing.
*
* @module @openclaw/oc-path/slug
*/
const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const COLLAPSE_HYPHENS = /-+/g;
const TRIM_HYPHENS = /^-+|-+$/g;
/** Empty string for input with no slug-valid chars; callers treat as not matchable. */
function slugify(text) {
	return text.toLowerCase().replace(/_/g, "-").replace(NON_SLUG_CHARS, "-").replace(COLLAPSE_HYPHENS, "-").replace(TRIM_HYPHENS, "");
}
//#endregion
//#region extensions/oc-path/src/oc-path/parse.ts
/**
* Markdown parser for workspace files: frontmatter + preamble + H2
* blocks (with bullet items as the only addressable structural child).
* Tokenization via markdown-it; frontmatter handled here.
*
* Grammar opinions (indented `##`, empty `## `, ordered lists, nested
* sub-bullets) live in lint rules, not the parser.
*
* Byte-fidelity: `emitMd(parse(raw)) === raw`.
*
* @module @openclaw/oc-path/parse
*/
const FENCE = "---";
const BOM = "﻿";
const KV_RE = /^([^:]+?)\s*:\s*(.+)$/;
const md = new MarkdownIt({ html: true });
function parseMd(raw) {
	const diagnostics = [];
	const lines = (raw.startsWith(BOM) ? raw.slice(1) : raw).split(/\r?\n/);
	const fm = detectFrontmatter(lines, diagnostics);
	const bodyStartIdx = fm === null ? 0 : fm.endLine + 1;
	const bodyLines = lines.slice(bodyStartIdx);
	const bodyFileLine = bodyStartIdx + 1;
	const { preamble, blocks } = walkBlocks(md.parse(bodyLines.join("\n"), {}), bodyLines, bodyFileLine);
	return {
		ast: {
			kind: "md",
			raw,
			frontmatter: fm?.entries ?? [],
			preamble,
			blocks
		},
		diagnostics
	};
}
function detectFrontmatter(lines, diagnostics) {
	if (lines.length < 2 || lines[0] !== FENCE) return null;
	let closeIndex = -1;
	for (let i = 1; i < lines.length; i++) if (lines[i] === FENCE) {
		closeIndex = i;
		break;
	}
	if (closeIndex === -1) {
		diagnostics.push({
			line: 1,
			message: "frontmatter opens with --- but never closes",
			severity: "warning",
			code: "OC_FRONTMATTER_UNCLOSED"
		});
		return null;
	}
	const entries = [];
	for (let i = 1; i < closeIndex; i++) {
		const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]);
		if (m !== null) entries.push({
			key: m[1],
			value: unquote(m[2].trim()),
			line: i + 1
		});
	}
	return {
		entries,
		endLine: closeIndex
	};
}
function unquote(value) {
	if (value.length >= 2) {
		const f = value.charCodeAt(0);
		if (f === value.charCodeAt(value.length - 1) && (f === 34 || f === 39)) return value.slice(1, -1);
	}
	return value;
}
function walkBlocks(tokens, bodyLines, bodyFileLine) {
	const h2 = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type === "heading_open" && t.tag === "h2" && t.markup === "##" && t.map !== null) {
			const inline = tokens[i + 1];
			h2.push({
				tokenIdx: i,
				lineIdx: t.map[0],
				text: inline?.content ?? ""
			});
		}
	}
	if (h2.length === 0) return {
		preamble: bodyLines.join("\n"),
		blocks: []
	};
	const preamble = bodyLines.slice(0, h2[0].lineIdx).join("\n");
	const blocks = [];
	for (let h = 0; h < h2.length; h++) {
		const start = h2[h].lineIdx;
		const end = h + 1 < h2.length ? h2[h + 1].lineIdx : bodyLines.length;
		const tokenStart = h2[h].tokenIdx + 3;
		const tokenEnd = h + 1 < h2.length ? h2[h + 1].tokenIdx : tokens.length;
		const blockTokens = tokens.slice(tokenStart, tokenEnd);
		blocks.push({
			heading: h2[h].text,
			slug: slugify(h2[h].text),
			line: bodyFileLine + start,
			bodyText: bodyLines.slice(start + 1, end).join("\n"),
			items: extractItems(blockTokens, bodyFileLine)
		});
	}
	return {
		preamble,
		blocks
	};
}
function extractItems(tokens, bodyFileLine) {
	const items = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== "list_item_open" || t.map === null) continue;
		let nestedDepth = 0;
		let text = "";
		for (let j = i + 1; j < tokens.length; j++) {
			const x = tokens[j];
			if (x.type === "list_item_close" && nestedDepth === 0) break;
			if (x.type === "bullet_list_open" || x.type === "ordered_list_open") nestedDepth++;
			else if (x.type === "bullet_list_close" || x.type === "ordered_list_close") nestedDepth--;
			else if (x.type === "inline" && nestedDepth === 0 && text === "") text = x.content;
		}
		const kvMatch = KV_RE.exec(text);
		items.push({
			text,
			slug: kvMatch ? slugify(kvMatch[1]) : slugify(text),
			line: bodyFileLine + t.map[0],
			...kvMatch !== null ? { kv: {
				key: kvMatch[1].trim(),
				value: kvMatch[2].trim()
			} } : {}
		});
	}
	return items;
}
//#endregion
//#region node_modules/jsonc-parser/lib/esm/impl/scanner.js
/**
* Creates a JSON scanner on the given text.
* If ignoreTrivia is set, whitespaces or comments are ignored.
*/
function createScanner(text, ignoreTrivia = false) {
	const len = text.length;
	let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
	function scanHexDigits(count, exact) {
		let digits = 0;
		let value = 0;
		while (digits < count || !exact) {
			let ch = text.charCodeAt(pos);
			if (ch >= 48 && ch <= 57) value = value * 16 + ch - 48;
			else if (ch >= 65 && ch <= 70) value = value * 16 + ch - 65 + 10;
			else if (ch >= 97 && ch <= 102) value = value * 16 + ch - 97 + 10;
			else break;
			pos++;
			digits++;
		}
		if (digits < count) value = -1;
		return value;
	}
	function setPosition(newPosition) {
		pos = newPosition;
		value = "";
		tokenOffset = 0;
		token = 16;
		scanError = 0;
	}
	function scanNumber() {
		let start = pos;
		if (text.charCodeAt(pos) === 48) pos++;
		else {
			pos++;
			while (pos < text.length && isDigit(text.charCodeAt(pos))) pos++;
		}
		if (pos < text.length && text.charCodeAt(pos) === 46) {
			pos++;
			if (pos < text.length && isDigit(text.charCodeAt(pos))) {
				pos++;
				while (pos < text.length && isDigit(text.charCodeAt(pos))) pos++;
			} else {
				scanError = 3;
				return text.substring(start, pos);
			}
		}
		let end = pos;
		if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
			pos++;
			if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) pos++;
			if (pos < text.length && isDigit(text.charCodeAt(pos))) {
				pos++;
				while (pos < text.length && isDigit(text.charCodeAt(pos))) pos++;
				end = pos;
			} else scanError = 3;
		}
		return text.substring(start, end);
	}
	function scanString() {
		let result = "", start = pos;
		while (true) {
			if (pos >= len) {
				result += text.substring(start, pos);
				scanError = 2;
				break;
			}
			const ch = text.charCodeAt(pos);
			if (ch === 34) {
				result += text.substring(start, pos);
				pos++;
				break;
			}
			if (ch === 92) {
				result += text.substring(start, pos);
				pos++;
				if (pos >= len) {
					scanError = 2;
					break;
				}
				switch (text.charCodeAt(pos++)) {
					case 34:
						result += "\"";
						break;
					case 92:
						result += "\\";
						break;
					case 47:
						result += "/";
						break;
					case 98:
						result += "\b";
						break;
					case 102:
						result += "\f";
						break;
					case 110:
						result += "\n";
						break;
					case 114:
						result += "\r";
						break;
					case 116:
						result += "	";
						break;
					case 117:
						const ch3 = scanHexDigits(4, true);
						if (ch3 >= 0) result += String.fromCharCode(ch3);
						else scanError = 4;
						break;
					default: scanError = 5;
				}
				start = pos;
				continue;
			}
			if (ch >= 0 && ch <= 31) if (isLineBreak(ch)) {
				result += text.substring(start, pos);
				scanError = 2;
				break;
			} else scanError = 6;
			pos++;
		}
		return result;
	}
	function scanNext() {
		value = "";
		scanError = 0;
		tokenOffset = pos;
		lineStartOffset = lineNumber;
		prevTokenLineStartOffset = tokenLineStartOffset;
		if (pos >= len) {
			tokenOffset = len;
			return token = 17;
		}
		let code = text.charCodeAt(pos);
		if (isWhiteSpace(code)) {
			do {
				pos++;
				value += String.fromCharCode(code);
				code = text.charCodeAt(pos);
			} while (isWhiteSpace(code));
			return token = 15;
		}
		if (isLineBreak(code)) {
			pos++;
			value += String.fromCharCode(code);
			if (code === 13 && text.charCodeAt(pos) === 10) {
				pos++;
				value += "\n";
			}
			lineNumber++;
			tokenLineStartOffset = pos;
			return token = 14;
		}
		switch (code) {
			case 123:
				pos++;
				return token = 1;
			case 125:
				pos++;
				return token = 2;
			case 91:
				pos++;
				return token = 3;
			case 93:
				pos++;
				return token = 4;
			case 58:
				pos++;
				return token = 6;
			case 44:
				pos++;
				return token = 5;
			case 34:
				pos++;
				value = scanString();
				return token = 10;
			case 47:
				const start = pos - 1;
				if (text.charCodeAt(pos + 1) === 47) {
					pos += 2;
					while (pos < len) {
						if (isLineBreak(text.charCodeAt(pos))) break;
						pos++;
					}
					value = text.substring(start, pos);
					return token = 12;
				}
				if (text.charCodeAt(pos + 1) === 42) {
					pos += 2;
					const safeLength = len - 1;
					let commentClosed = false;
					while (pos < safeLength) {
						const ch = text.charCodeAt(pos);
						if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
							pos += 2;
							commentClosed = true;
							break;
						}
						pos++;
						if (isLineBreak(ch)) {
							if (ch === 13 && text.charCodeAt(pos) === 10) pos++;
							lineNumber++;
							tokenLineStartOffset = pos;
						}
					}
					if (!commentClosed) {
						pos++;
						scanError = 1;
					}
					value = text.substring(start, pos);
					return token = 13;
				}
				value += String.fromCharCode(code);
				pos++;
				return token = 16;
			case 45:
				value += String.fromCharCode(code);
				pos++;
				if (pos === len || !isDigit(text.charCodeAt(pos))) return token = 16;
			case 48:
			case 49:
			case 50:
			case 51:
			case 52:
			case 53:
			case 54:
			case 55:
			case 56:
			case 57:
				value += scanNumber();
				return token = 11;
			default:
				while (pos < len && isUnknownContentCharacter(code)) {
					pos++;
					code = text.charCodeAt(pos);
				}
				if (tokenOffset !== pos) {
					value = text.substring(tokenOffset, pos);
					switch (value) {
						case "true": return token = 8;
						case "false": return token = 9;
						case "null": return token = 7;
					}
					return token = 16;
				}
				value += String.fromCharCode(code);
				pos++;
				return token = 16;
		}
	}
	function isUnknownContentCharacter(code) {
		if (isWhiteSpace(code) || isLineBreak(code)) return false;
		switch (code) {
			case 125:
			case 93:
			case 123:
			case 91:
			case 34:
			case 58:
			case 44:
			case 47: return false;
		}
		return true;
	}
	function scanNextNonTrivia() {
		let result;
		do
			result = scanNext();
		while (result >= 12 && result <= 15);
		return result;
	}
	return {
		setPosition,
		getPosition: () => pos,
		scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
		getToken: () => token,
		getTokenValue: () => value,
		getTokenOffset: () => tokenOffset,
		getTokenLength: () => pos - tokenOffset,
		getTokenStartLine: () => lineStartOffset,
		getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
		getTokenError: () => scanError
	};
}
function isWhiteSpace(ch) {
	return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
	return ch === 10 || ch === 13;
}
function isDigit(ch) {
	return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes) {
	CharacterCodes[CharacterCodes["lineFeed"] = 10] = "lineFeed";
	CharacterCodes[CharacterCodes["carriageReturn"] = 13] = "carriageReturn";
	CharacterCodes[CharacterCodes["space"] = 32] = "space";
	CharacterCodes[CharacterCodes["_0"] = 48] = "_0";
	CharacterCodes[CharacterCodes["_1"] = 49] = "_1";
	CharacterCodes[CharacterCodes["_2"] = 50] = "_2";
	CharacterCodes[CharacterCodes["_3"] = 51] = "_3";
	CharacterCodes[CharacterCodes["_4"] = 52] = "_4";
	CharacterCodes[CharacterCodes["_5"] = 53] = "_5";
	CharacterCodes[CharacterCodes["_6"] = 54] = "_6";
	CharacterCodes[CharacterCodes["_7"] = 55] = "_7";
	CharacterCodes[CharacterCodes["_8"] = 56] = "_8";
	CharacterCodes[CharacterCodes["_9"] = 57] = "_9";
	CharacterCodes[CharacterCodes["a"] = 97] = "a";
	CharacterCodes[CharacterCodes["b"] = 98] = "b";
	CharacterCodes[CharacterCodes["c"] = 99] = "c";
	CharacterCodes[CharacterCodes["d"] = 100] = "d";
	CharacterCodes[CharacterCodes["e"] = 101] = "e";
	CharacterCodes[CharacterCodes["f"] = 102] = "f";
	CharacterCodes[CharacterCodes["g"] = 103] = "g";
	CharacterCodes[CharacterCodes["h"] = 104] = "h";
	CharacterCodes[CharacterCodes["i"] = 105] = "i";
	CharacterCodes[CharacterCodes["j"] = 106] = "j";
	CharacterCodes[CharacterCodes["k"] = 107] = "k";
	CharacterCodes[CharacterCodes["l"] = 108] = "l";
	CharacterCodes[CharacterCodes["m"] = 109] = "m";
	CharacterCodes[CharacterCodes["n"] = 110] = "n";
	CharacterCodes[CharacterCodes["o"] = 111] = "o";
	CharacterCodes[CharacterCodes["p"] = 112] = "p";
	CharacterCodes[CharacterCodes["q"] = 113] = "q";
	CharacterCodes[CharacterCodes["r"] = 114] = "r";
	CharacterCodes[CharacterCodes["s"] = 115] = "s";
	CharacterCodes[CharacterCodes["t"] = 116] = "t";
	CharacterCodes[CharacterCodes["u"] = 117] = "u";
	CharacterCodes[CharacterCodes["v"] = 118] = "v";
	CharacterCodes[CharacterCodes["w"] = 119] = "w";
	CharacterCodes[CharacterCodes["x"] = 120] = "x";
	CharacterCodes[CharacterCodes["y"] = 121] = "y";
	CharacterCodes[CharacterCodes["z"] = 122] = "z";
	CharacterCodes[CharacterCodes["A"] = 65] = "A";
	CharacterCodes[CharacterCodes["B"] = 66] = "B";
	CharacterCodes[CharacterCodes["C"] = 67] = "C";
	CharacterCodes[CharacterCodes["D"] = 68] = "D";
	CharacterCodes[CharacterCodes["E"] = 69] = "E";
	CharacterCodes[CharacterCodes["F"] = 70] = "F";
	CharacterCodes[CharacterCodes["G"] = 71] = "G";
	CharacterCodes[CharacterCodes["H"] = 72] = "H";
	CharacterCodes[CharacterCodes["I"] = 73] = "I";
	CharacterCodes[CharacterCodes["J"] = 74] = "J";
	CharacterCodes[CharacterCodes["K"] = 75] = "K";
	CharacterCodes[CharacterCodes["L"] = 76] = "L";
	CharacterCodes[CharacterCodes["M"] = 77] = "M";
	CharacterCodes[CharacterCodes["N"] = 78] = "N";
	CharacterCodes[CharacterCodes["O"] = 79] = "O";
	CharacterCodes[CharacterCodes["P"] = 80] = "P";
	CharacterCodes[CharacterCodes["Q"] = 81] = "Q";
	CharacterCodes[CharacterCodes["R"] = 82] = "R";
	CharacterCodes[CharacterCodes["S"] = 83] = "S";
	CharacterCodes[CharacterCodes["T"] = 84] = "T";
	CharacterCodes[CharacterCodes["U"] = 85] = "U";
	CharacterCodes[CharacterCodes["V"] = 86] = "V";
	CharacterCodes[CharacterCodes["W"] = 87] = "W";
	CharacterCodes[CharacterCodes["X"] = 88] = "X";
	CharacterCodes[CharacterCodes["Y"] = 89] = "Y";
	CharacterCodes[CharacterCodes["Z"] = 90] = "Z";
	CharacterCodes[CharacterCodes["asterisk"] = 42] = "asterisk";
	CharacterCodes[CharacterCodes["backslash"] = 92] = "backslash";
	CharacterCodes[CharacterCodes["closeBrace"] = 125] = "closeBrace";
	CharacterCodes[CharacterCodes["closeBracket"] = 93] = "closeBracket";
	CharacterCodes[CharacterCodes["colon"] = 58] = "colon";
	CharacterCodes[CharacterCodes["comma"] = 44] = "comma";
	CharacterCodes[CharacterCodes["dot"] = 46] = "dot";
	CharacterCodes[CharacterCodes["doubleQuote"] = 34] = "doubleQuote";
	CharacterCodes[CharacterCodes["minus"] = 45] = "minus";
	CharacterCodes[CharacterCodes["openBrace"] = 123] = "openBrace";
	CharacterCodes[CharacterCodes["openBracket"] = 91] = "openBracket";
	CharacterCodes[CharacterCodes["plus"] = 43] = "plus";
	CharacterCodes[CharacterCodes["slash"] = 47] = "slash";
	CharacterCodes[CharacterCodes["formFeed"] = 12] = "formFeed";
	CharacterCodes[CharacterCodes["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));
//#endregion
//#region node_modules/jsonc-parser/lib/esm/impl/string-intern.js
const cachedSpaces = new Array(20).fill(0).map((_, index) => {
	return " ".repeat(index);
});
const maxCachedValues = 200;
const cachedBreakLinesWithSpaces = {
	" ": {
		"\n": new Array(maxCachedValues).fill(0).map((_, index) => {
			return "\n" + " ".repeat(index);
		}),
		"\r": new Array(maxCachedValues).fill(0).map((_, index) => {
			return "\r" + " ".repeat(index);
		}),
		"\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
			return "\r\n" + " ".repeat(index);
		})
	},
	"	": {
		"\n": new Array(maxCachedValues).fill(0).map((_, index) => {
			return "\n" + "	".repeat(index);
		}),
		"\r": new Array(maxCachedValues).fill(0).map((_, index) => {
			return "\r" + "	".repeat(index);
		}),
		"\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
			return "\r\n" + "	".repeat(index);
		})
	}
};
const supportedEols = [
	"\n",
	"\r",
	"\r\n"
];
//#endregion
//#region node_modules/jsonc-parser/lib/esm/impl/format.js
function format(documentText, range, options) {
	let initialIndentLevel;
	let formatText;
	let formatTextStart;
	let rangeStart;
	let rangeEnd;
	if (range) {
		rangeStart = range.offset;
		rangeEnd = rangeStart + range.length;
		formatTextStart = rangeStart;
		while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) formatTextStart--;
		let endOffset = rangeEnd;
		while (endOffset < documentText.length && !isEOL(documentText, endOffset)) endOffset++;
		formatText = documentText.substring(formatTextStart, endOffset);
		initialIndentLevel = computeIndentLevel(formatText, options);
	} else {
		formatText = documentText;
		initialIndentLevel = 0;
		formatTextStart = 0;
		rangeStart = 0;
		rangeEnd = documentText.length;
	}
	const eol = getEOL(options, documentText);
	const eolFastPathSupported = supportedEols.includes(eol);
	let numberLineBreaks = 0;
	let indentLevel = 0;
	let indentValue;
	if (options.insertSpaces) indentValue = cachedSpaces[options.tabSize || 4] ?? repeat(cachedSpaces[1], options.tabSize || 4);
	else indentValue = "	";
	const indentType = indentValue === "	" ? "	" : " ";
	let scanner = createScanner(formatText, false);
	let hasError = false;
	function newLinesAndIndent() {
		if (numberLineBreaks > 1) return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
		const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
		if (!eolFastPathSupported || amountOfSpaces > cachedBreakLinesWithSpaces[indentType][eol].length) return eol + repeat(indentValue, initialIndentLevel + indentLevel);
		if (amountOfSpaces <= 0) return eol;
		return cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
	}
	function scanNext() {
		let token = scanner.scan();
		numberLineBreaks = 0;
		while (token === 15 || token === 14) {
			if (token === 14 && options.keepLines) numberLineBreaks += 1;
			else if (token === 14) numberLineBreaks = 1;
			token = scanner.scan();
		}
		hasError = token === 16 || scanner.getTokenError() !== 0;
		return token;
	}
	const editOperations = [];
	function addEdit(text, startOffset, endOffset) {
		if (!hasError && (!range || startOffset < rangeEnd && endOffset > rangeStart) && documentText.substring(startOffset, endOffset) !== text) editOperations.push({
			offset: startOffset,
			length: endOffset - startOffset,
			content: text
		});
	}
	let firstToken = scanNext();
	if (options.keepLines && numberLineBreaks > 0) addEdit(repeat(eol, numberLineBreaks), 0, 0);
	if (firstToken !== 17) {
		let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
		addEdit(indentValue.length * initialIndentLevel < 20 && options.insertSpaces ? cachedSpaces[indentValue.length * initialIndentLevel] : repeat(indentValue, initialIndentLevel), formatTextStart, firstTokenStart);
	}
	while (firstToken !== 17) {
		let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
		let secondToken = scanNext();
		let replaceContent = "";
		let needsLineBreak = false;
		while (numberLineBreaks === 0 && (secondToken === 12 || secondToken === 13)) {
			let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
			addEdit(cachedSpaces[1], firstTokenEnd, commentTokenStart);
			firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
			needsLineBreak = secondToken === 12;
			replaceContent = needsLineBreak ? newLinesAndIndent() : "";
			secondToken = scanNext();
		}
		if (secondToken === 2) {
			if (firstToken !== 1) indentLevel--;
			if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1) replaceContent = newLinesAndIndent();
			else if (options.keepLines) replaceContent = cachedSpaces[1];
		} else if (secondToken === 4) {
			if (firstToken !== 3) indentLevel--;
			if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3) replaceContent = newLinesAndIndent();
			else if (options.keepLines) replaceContent = cachedSpaces[1];
		} else {
			switch (firstToken) {
				case 3:
				case 1:
					indentLevel++;
					if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) replaceContent = newLinesAndIndent();
					else replaceContent = cachedSpaces[1];
					break;
				case 5:
					if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) replaceContent = newLinesAndIndent();
					else replaceContent = cachedSpaces[1];
					break;
				case 12:
					replaceContent = newLinesAndIndent();
					break;
				case 13:
					if (numberLineBreaks > 0) replaceContent = newLinesAndIndent();
					else if (!needsLineBreak) replaceContent = cachedSpaces[1];
					break;
				case 6:
					if (options.keepLines && numberLineBreaks > 0) replaceContent = newLinesAndIndent();
					else if (!needsLineBreak) replaceContent = cachedSpaces[1];
					break;
				case 10:
					if (options.keepLines && numberLineBreaks > 0) replaceContent = newLinesAndIndent();
					else if (secondToken === 6 && !needsLineBreak) replaceContent = "";
					break;
				case 7:
				case 8:
				case 9:
				case 11:
				case 2:
				case 4:
					if (options.keepLines && numberLineBreaks > 0) replaceContent = newLinesAndIndent();
					else if ((secondToken === 12 || secondToken === 13) && !needsLineBreak) replaceContent = cachedSpaces[1];
					else if (secondToken !== 5 && secondToken !== 17) hasError = true;
					break;
				case 16:
					hasError = true;
					break;
			}
			if (numberLineBreaks > 0 && (secondToken === 12 || secondToken === 13)) replaceContent = newLinesAndIndent();
		}
		if (secondToken === 17) if (options.keepLines && numberLineBreaks > 0) replaceContent = newLinesAndIndent();
		else replaceContent = options.insertFinalNewline ? eol : "";
		const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
		addEdit(replaceContent, firstTokenEnd, secondTokenStart);
		firstToken = secondToken;
	}
	return editOperations;
}
function repeat(s, count) {
	let result = "";
	for (let i = 0; i < count; i++) result += s;
	return result;
}
function computeIndentLevel(content, options) {
	let i = 0;
	let nChars = 0;
	const tabSize = options.tabSize || 4;
	while (i < content.length) {
		let ch = content.charAt(i);
		if (ch === cachedSpaces[1]) nChars++;
		else if (ch === "	") nChars += tabSize;
		else break;
		i++;
	}
	return Math.floor(nChars / tabSize);
}
function getEOL(options, text) {
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "\r") {
			if (i + 1 < text.length && text.charAt(i + 1) === "\n") return "\r\n";
			return "\r";
		} else if (ch === "\n") return "\n";
	}
	return options && options.eol || "\n";
}
function isEOL(text, offset) {
	return "\r\n".indexOf(text.charAt(offset)) !== -1;
}
//#endregion
//#region node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions) {
	ParseOptions.DEFAULT = { allowTrailingComma: false };
})(ParseOptions || (ParseOptions = {}));
/**
* Parses the given text and returns a tree representation the JSON content. On invalid input, the parser tries to be as fault tolerant as possible, but still return a result.
*/
function parseTree$1(text, errors = [], options = ParseOptions.DEFAULT) {
	let currentParent = {
		type: "array",
		offset: -1,
		length: -1,
		children: [],
		parent: void 0
	};
	function ensurePropertyComplete(endOffset) {
		if (currentParent.type === "property") {
			currentParent.length = endOffset - currentParent.offset;
			currentParent = currentParent.parent;
		}
	}
	function onValue(valueNode) {
		currentParent.children.push(valueNode);
		return valueNode;
	}
	visit(text, {
		onObjectBegin: (offset) => {
			currentParent = onValue({
				type: "object",
				offset,
				length: -1,
				parent: currentParent,
				children: []
			});
		},
		onObjectProperty: (name, offset, length) => {
			currentParent = onValue({
				type: "property",
				offset,
				length: -1,
				parent: currentParent,
				children: []
			});
			currentParent.children.push({
				type: "string",
				value: name,
				offset,
				length,
				parent: currentParent
			});
		},
		onObjectEnd: (offset, length) => {
			ensurePropertyComplete(offset + length);
			currentParent.length = offset + length - currentParent.offset;
			currentParent = currentParent.parent;
			ensurePropertyComplete(offset + length);
		},
		onArrayBegin: (offset, length) => {
			currentParent = onValue({
				type: "array",
				offset,
				length: -1,
				parent: currentParent,
				children: []
			});
		},
		onArrayEnd: (offset, length) => {
			currentParent.length = offset + length - currentParent.offset;
			currentParent = currentParent.parent;
			ensurePropertyComplete(offset + length);
		},
		onLiteralValue: (value, offset, length) => {
			onValue({
				type: getNodeType(value),
				offset,
				length,
				parent: currentParent,
				value
			});
			ensurePropertyComplete(offset + length);
		},
		onSeparator: (sep, offset, length) => {
			if (currentParent.type === "property") {
				if (sep === ":") currentParent.colonOffset = offset;
				else if (sep === ",") ensurePropertyComplete(offset);
			}
		},
		onError: (error, offset, length) => {
			errors.push({
				error,
				offset,
				length
			});
		}
	}, options);
	const result = currentParent.children[0];
	if (result) delete result.parent;
	return result;
}
/**
* Finds the node at the given path in a JSON DOM.
*/
function findNodeAtLocation(root, path) {
	if (!root) return;
	let node = root;
	for (let segment of path) if (typeof segment === "string") {
		if (node.type !== "object" || !Array.isArray(node.children)) return;
		let found = false;
		for (const propertyNode of node.children) if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
			node = propertyNode.children[1];
			found = true;
			break;
		}
		if (!found) return;
	} else {
		const index = segment;
		if (node.type !== "array" || index < 0 || !Array.isArray(node.children) || index >= node.children.length) return;
		node = node.children[index];
	}
	return node;
}
/**
* Parses the given text and invokes the visitor functions for each object, array and literal reached.
*/
function visit(text, visitor, options = ParseOptions.DEFAULT) {
	const _scanner = createScanner(text, false);
	const _jsonPath = [];
	let suppressedCallbacks = 0;
	function toNoArgVisit(visitFunction) {
		return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
	}
	function toOneArgVisit(visitFunction) {
		return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
	}
	function toOneArgVisitWithPath(visitFunction) {
		return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
	}
	function toBeginVisit(visitFunction) {
		return visitFunction ? () => {
			if (suppressedCallbacks > 0) suppressedCallbacks++;
			else if (visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) === false) suppressedCallbacks = 1;
		} : () => true;
	}
	function toEndVisit(visitFunction) {
		return visitFunction ? () => {
			if (suppressedCallbacks > 0) suppressedCallbacks--;
			if (suppressedCallbacks === 0) visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
		} : () => true;
	}
	const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
	const disallowComments = options && options.disallowComments;
	const allowTrailingComma = options && options.allowTrailingComma;
	function scanNext() {
		while (true) {
			const token = _scanner.scan();
			switch (_scanner.getTokenError()) {
				case 4:
					handleError(14);
					break;
				case 5:
					handleError(15);
					break;
				case 3:
					handleError(13);
					break;
				case 1:
					if (!disallowComments) handleError(11);
					break;
				case 2:
					handleError(12);
					break;
				case 6:
					handleError(16);
					break;
			}
			switch (token) {
				case 12:
				case 13:
					if (disallowComments) handleError(10);
					else onComment();
					break;
				case 16:
					handleError(1);
					break;
				case 15:
				case 14: break;
				default: return token;
			}
		}
	}
	function handleError(error, skipUntilAfter = [], skipUntil = []) {
		onError(error);
		if (skipUntilAfter.length + skipUntil.length > 0) {
			let token = _scanner.getToken();
			while (token !== 17) {
				if (skipUntilAfter.indexOf(token) !== -1) {
					scanNext();
					break;
				} else if (skipUntil.indexOf(token) !== -1) break;
				token = scanNext();
			}
		}
	}
	function parseString(isValue) {
		const value = _scanner.getTokenValue();
		if (isValue) onLiteralValue(value);
		else {
			onObjectProperty(value);
			_jsonPath.push(value);
		}
		scanNext();
		return true;
	}
	function parseLiteral() {
		switch (_scanner.getToken()) {
			case 11:
				const tokenValue = _scanner.getTokenValue();
				let value = Number(tokenValue);
				if (isNaN(value)) {
					handleError(2);
					value = 0;
				}
				onLiteralValue(value);
				break;
			case 7:
				onLiteralValue(null);
				break;
			case 8:
				onLiteralValue(true);
				break;
			case 9:
				onLiteralValue(false);
				break;
			default: return false;
		}
		scanNext();
		return true;
	}
	function parseProperty() {
		if (_scanner.getToken() !== 10) {
			handleError(3, [], [2, 5]);
			return false;
		}
		parseString(false);
		if (_scanner.getToken() === 6) {
			onSeparator(":");
			scanNext();
			if (!parseValue()) handleError(4, [], [2, 5]);
		} else handleError(5, [], [2, 5]);
		_jsonPath.pop();
		return true;
	}
	function parseObject() {
		onObjectBegin();
		scanNext();
		let needsComma = false;
		while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
			if (_scanner.getToken() === 5) {
				if (!needsComma) handleError(4, [], []);
				onSeparator(",");
				scanNext();
				if (_scanner.getToken() === 2 && allowTrailingComma) break;
			} else if (needsComma) handleError(6, [], []);
			if (!parseProperty()) handleError(4, [], [2, 5]);
			needsComma = true;
		}
		onObjectEnd();
		if (_scanner.getToken() !== 2) handleError(7, [2], []);
		else scanNext();
		return true;
	}
	function parseArray() {
		onArrayBegin();
		scanNext();
		let isFirstElement = true;
		let needsComma = false;
		while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
			if (_scanner.getToken() === 5) {
				if (!needsComma) handleError(4, [], []);
				onSeparator(",");
				scanNext();
				if (_scanner.getToken() === 4 && allowTrailingComma) break;
			} else if (needsComma) handleError(6, [], []);
			if (isFirstElement) {
				_jsonPath.push(0);
				isFirstElement = false;
			} else _jsonPath[_jsonPath.length - 1]++;
			if (!parseValue()) handleError(4, [], [4, 5]);
			needsComma = true;
		}
		onArrayEnd();
		if (!isFirstElement) _jsonPath.pop();
		if (_scanner.getToken() !== 4) handleError(8, [4], []);
		else scanNext();
		return true;
	}
	function parseValue() {
		switch (_scanner.getToken()) {
			case 3: return parseArray();
			case 1: return parseObject();
			case 10: return parseString(true);
			default: return parseLiteral();
		}
	}
	scanNext();
	if (_scanner.getToken() === 17) {
		if (options.allowEmptyContent) return true;
		handleError(4, [], []);
		return false;
	}
	if (!parseValue()) {
		handleError(4, [], []);
		return false;
	}
	if (_scanner.getToken() !== 17) handleError(9, [], []);
	return true;
}
function getNodeType(value) {
	switch (typeof value) {
		case "boolean": return "boolean";
		case "number": return "number";
		case "string": return "string";
		case "object":
			if (!value) return "null";
			else if (Array.isArray(value)) return "array";
			return "object";
		default: return "null";
	}
}
//#endregion
//#region node_modules/jsonc-parser/lib/esm/impl/edit.js
function setProperty(text, originalPath, value, options) {
	const path = originalPath.slice();
	const root = parseTree$1(text, []);
	let parent = void 0;
	let lastSegment = void 0;
	while (path.length > 0) {
		lastSegment = path.pop();
		parent = findNodeAtLocation(root, path);
		if (parent === void 0 && value !== void 0) if (typeof lastSegment === "string") value = { [lastSegment]: value };
		else value = [value];
		else break;
	}
	if (!parent) {
		if (value === void 0) throw new Error("Can not delete in empty document");
		return withFormatting(text, {
			offset: root ? root.offset : 0,
			length: root ? root.length : 0,
			content: JSON.stringify(value)
		}, options);
	} else if (parent.type === "object" && typeof lastSegment === "string" && Array.isArray(parent.children)) {
		const existing = findNodeAtLocation(parent, [lastSegment]);
		if (existing !== void 0) if (value === void 0) {
			if (!existing.parent) throw new Error("Malformed AST");
			const propertyIndex = parent.children.indexOf(existing.parent);
			let removeBegin;
			let removeEnd = existing.parent.offset + existing.parent.length;
			if (propertyIndex > 0) {
				let previous = parent.children[propertyIndex - 1];
				removeBegin = previous.offset + previous.length;
			} else {
				removeBegin = parent.offset + 1;
				if (parent.children.length > 1) removeEnd = parent.children[1].offset;
			}
			return withFormatting(text, {
				offset: removeBegin,
				length: removeEnd - removeBegin,
				content: ""
			}, options);
		} else return withFormatting(text, {
			offset: existing.offset,
			length: existing.length,
			content: JSON.stringify(value)
		}, options);
		else {
			if (value === void 0) return [];
			const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
			const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map((p) => p.children[0].value)) : parent.children.length;
			let edit;
			if (index > 0) {
				let previous = parent.children[index - 1];
				edit = {
					offset: previous.offset + previous.length,
					length: 0,
					content: "," + newProperty
				};
			} else if (parent.children.length === 0) edit = {
				offset: parent.offset + 1,
				length: 0,
				content: newProperty
			};
			else edit = {
				offset: parent.offset + 1,
				length: 0,
				content: newProperty + ","
			};
			return withFormatting(text, edit, options);
		}
	} else if (parent.type === "array" && typeof lastSegment === "number" && Array.isArray(parent.children)) {
		const insertIndex = lastSegment;
		if (insertIndex === -1) {
			const newProperty = `${JSON.stringify(value)}`;
			let edit;
			if (parent.children.length === 0) edit = {
				offset: parent.offset + 1,
				length: 0,
				content: newProperty
			};
			else {
				const previous = parent.children[parent.children.length - 1];
				edit = {
					offset: previous.offset + previous.length,
					length: 0,
					content: "," + newProperty
				};
			}
			return withFormatting(text, edit, options);
		} else if (value === void 0 && parent.children.length >= 0) {
			const removalIndex = lastSegment;
			const toRemove = parent.children[removalIndex];
			let edit;
			if (parent.children.length === 1) edit = {
				offset: parent.offset + 1,
				length: parent.length - 2,
				content: ""
			};
			else if (parent.children.length - 1 === removalIndex) {
				let previous = parent.children[removalIndex - 1];
				let offset = previous.offset + previous.length;
				edit = {
					offset,
					length: parent.offset + parent.length - 2 - offset,
					content: ""
				};
			} else edit = {
				offset: toRemove.offset,
				length: parent.children[removalIndex + 1].offset - toRemove.offset,
				content: ""
			};
			return withFormatting(text, edit, options);
		} else if (value !== void 0) {
			let edit;
			const newProperty = `${JSON.stringify(value)}`;
			if (!options.isArrayInsertion && parent.children.length > lastSegment) {
				const toModify = parent.children[lastSegment];
				edit = {
					offset: toModify.offset,
					length: toModify.length,
					content: newProperty
				};
			} else if (parent.children.length === 0 || lastSegment === 0) edit = {
				offset: parent.offset + 1,
				length: 0,
				content: parent.children.length === 0 ? newProperty : newProperty + ","
			};
			else {
				const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
				const previous = parent.children[index - 1];
				edit = {
					offset: previous.offset + previous.length,
					length: 0,
					content: "," + newProperty
				};
			}
			return withFormatting(text, edit, options);
		} else throw new Error(`Can not ${value === void 0 ? "remove" : options.isArrayInsertion ? "insert" : "modify"} Array index ${insertIndex} as length is not sufficient`);
	} else throw new Error(`Can not add ${typeof lastSegment !== "number" ? "index" : "property"} to parent of type ${parent.type}`);
}
function withFormatting(text, edit, options) {
	if (!options.formattingOptions) return [edit];
	let newText = applyEdit(text, edit);
	let begin = edit.offset;
	let end = edit.offset + edit.content.length;
	if (edit.length === 0 || edit.content.length === 0) {
		while (begin > 0 && !isEOL(newText, begin - 1)) begin--;
		while (end < newText.length && !isEOL(newText, end)) end++;
	}
	const edits = format(newText, {
		offset: begin,
		length: end - begin
	}, {
		...options.formattingOptions,
		keepLines: false
	});
	for (let i = edits.length - 1; i >= 0; i--) {
		const edit = edits[i];
		newText = applyEdit(newText, edit);
		begin = Math.min(begin, edit.offset);
		end = Math.max(end, edit.offset + edit.length);
		end += edit.content.length - edit.length;
	}
	const editLength = text.length - (newText.length - end) - begin;
	return [{
		offset: begin,
		length: editLength,
		content: newText.substring(begin, end)
	}];
}
function applyEdit(text, edit) {
	return text.substring(0, edit.offset) + edit.content + text.substring(edit.offset + edit.length);
}
//#endregion
//#region node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError) {
	ScanError[ScanError["None"] = 0] = "None";
	ScanError[ScanError["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
	ScanError[ScanError["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
	ScanError[ScanError["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
	ScanError[ScanError["InvalidUnicode"] = 4] = "InvalidUnicode";
	ScanError[ScanError["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
	ScanError[ScanError["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind) {
	SyntaxKind[SyntaxKind["OpenBraceToken"] = 1] = "OpenBraceToken";
	SyntaxKind[SyntaxKind["CloseBraceToken"] = 2] = "CloseBraceToken";
	SyntaxKind[SyntaxKind["OpenBracketToken"] = 3] = "OpenBracketToken";
	SyntaxKind[SyntaxKind["CloseBracketToken"] = 4] = "CloseBracketToken";
	SyntaxKind[SyntaxKind["CommaToken"] = 5] = "CommaToken";
	SyntaxKind[SyntaxKind["ColonToken"] = 6] = "ColonToken";
	SyntaxKind[SyntaxKind["NullKeyword"] = 7] = "NullKeyword";
	SyntaxKind[SyntaxKind["TrueKeyword"] = 8] = "TrueKeyword";
	SyntaxKind[SyntaxKind["FalseKeyword"] = 9] = "FalseKeyword";
	SyntaxKind[SyntaxKind["StringLiteral"] = 10] = "StringLiteral";
	SyntaxKind[SyntaxKind["NumericLiteral"] = 11] = "NumericLiteral";
	SyntaxKind[SyntaxKind["LineCommentTrivia"] = 12] = "LineCommentTrivia";
	SyntaxKind[SyntaxKind["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
	SyntaxKind[SyntaxKind["LineBreakTrivia"] = 14] = "LineBreakTrivia";
	SyntaxKind[SyntaxKind["Trivia"] = 15] = "Trivia";
	SyntaxKind[SyntaxKind["Unknown"] = 16] = "Unknown";
	SyntaxKind[SyntaxKind["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
/**
* Parses the given text and returns a tree representation the JSON content. On invalid input, the parser tries to be as fault tolerant as possible, but still return a result.
*/
const parseTree = parseTree$1;
var ParseErrorCode;
(function(ParseErrorCode) {
	ParseErrorCode[ParseErrorCode["InvalidSymbol"] = 1] = "InvalidSymbol";
	ParseErrorCode[ParseErrorCode["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
	ParseErrorCode[ParseErrorCode["PropertyNameExpected"] = 3] = "PropertyNameExpected";
	ParseErrorCode[ParseErrorCode["ValueExpected"] = 4] = "ValueExpected";
	ParseErrorCode[ParseErrorCode["ColonExpected"] = 5] = "ColonExpected";
	ParseErrorCode[ParseErrorCode["CommaExpected"] = 6] = "CommaExpected";
	ParseErrorCode[ParseErrorCode["CloseBraceExpected"] = 7] = "CloseBraceExpected";
	ParseErrorCode[ParseErrorCode["CloseBracketExpected"] = 8] = "CloseBracketExpected";
	ParseErrorCode[ParseErrorCode["EndOfFileExpected"] = 9] = "EndOfFileExpected";
	ParseErrorCode[ParseErrorCode["InvalidCommentToken"] = 10] = "InvalidCommentToken";
	ParseErrorCode[ParseErrorCode["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
	ParseErrorCode[ParseErrorCode["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
	ParseErrorCode[ParseErrorCode["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
	ParseErrorCode[ParseErrorCode["InvalidUnicode"] = 14] = "InvalidUnicode";
	ParseErrorCode[ParseErrorCode["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
	ParseErrorCode[ParseErrorCode["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function printParseErrorCode(code) {
	switch (code) {
		case 1: return "InvalidSymbol";
		case 2: return "InvalidNumberFormat";
		case 3: return "PropertyNameExpected";
		case 4: return "ValueExpected";
		case 5: return "ColonExpected";
		case 6: return "CommaExpected";
		case 7: return "CloseBraceExpected";
		case 8: return "CloseBracketExpected";
		case 9: return "EndOfFileExpected";
		case 10: return "InvalidCommentToken";
		case 11: return "UnexpectedEndOfComment";
		case 12: return "UnexpectedEndOfString";
		case 13: return "UnexpectedEndOfNumber";
		case 14: return "InvalidUnicode";
		case 15: return "InvalidEscapeCharacter";
		case 16: return "InvalidCharacter";
	}
	return "<unknown ParseErrorCode>";
}
/**
* Computes the edit operations needed to modify a value in the JSON document.
*
* @param documentText The input text
* @param path The path of the value to change. The path represents either to the document root, a property or an array item.
* If the path points to an non-existing property or item, it will be created.
* @param value The new value for the specified property or item. If the value is undefined,
* the property or item will be removed.
* @param options Options
* @returns The edit operations describing the changes to the original document, following the format described in {@linkcode EditResult}.
* To apply the edit operations to the input, use {@linkcode applyEdits}.
*/
function modify(text, path, value, options) {
	return setProperty(text, path, value, options);
}
/**
* Applies edits to an input string.
* @param text The input text
* @param edits Edit operations following the format described in {@linkcode EditResult}.
* @returns The text with the applied edits.
* @throws An error if the edit operations are not well-formed as described in {@linkcode EditResult}.
*/
function applyEdits(text, edits) {
	let sortedEdits = edits.slice(0).sort((a, b) => {
		const diff = a.offset - b.offset;
		if (diff === 0) return a.length - b.length;
		return diff;
	});
	let lastModifiedOffset = text.length;
	for (let i = sortedEdits.length - 1; i >= 0; i--) {
		let e = sortedEdits[i];
		if (e.offset + e.length <= lastModifiedOffset) text = applyEdit(text, e);
		else throw new Error("Overlapping edit");
		lastModifiedOffset = e.offset;
	}
	return text;
}
/**
* Hard cap on jsonc input size. `parseTree` is iterative and stack-safe
* but allocates a tree node per token regardless of depth — a 16 MiB
* input expanding to millions of nodes hits memory pressure long before
* `nodeToJsoncValue`'s `MAX_PARSE_DEPTH` walk would notice. Cap at the
* source level so allocation is bounded by file size, not token count.
*
* 16 MiB is well past every workspace-jsonc shape we care about
* (gateway.jsonc / openclaw.json / .openclaw/* are all <100 KiB in
* practice; the largest LKG-tracked configs we've seen sit at single-
* digit MB). Operators with legitimate larger inputs can lift the cap
* by patching this constant — no SDK affordance because it isn't a
* supported configuration.
*/
const MAX_JSONC_INPUT_BYTES = 16 * 1024 * 1024;
function parseJsonc(raw) {
	if (raw.trim().length === 0) return {
		ast: {
			kind: "jsonc",
			raw,
			root: null
		},
		diagnostics: []
	};
	if (raw.length > 16777216) return {
		ast: {
			kind: "jsonc",
			raw,
			root: null
		},
		diagnostics: [{
			line: 1,
			message: `input exceeds MAX_JSONC_INPUT_BYTES (${MAX_JSONC_INPUT_BYTES} bytes; got ${raw.length})`,
			severity: "error",
			code: "OC_JSONC_INPUT_TOO_LARGE"
		}]
	};
	const parseSource = raw.startsWith("﻿") ? raw.slice(1) : raw;
	const errors = [];
	const tree = parseTree(parseSource, errors, {
		allowTrailingComma: true,
		disallowComments: false,
		allowEmptyContent: true
	});
	const lineMap = createLineMap(raw);
	const diagnostics = errors.map((error) => toDiagnostic(error, lineMap, tree));
	let root = null;
	if (tree && diagnostics.every((d) => d.severity !== "error")) try {
		root = nodeToJsoncValue(tree, lineMap, 0);
	} catch (err) {
		diagnostics.push({
			line: 1,
			message: err instanceof Error ? err.message : String(err),
			severity: "error",
			code: "OC_JSONC_DEPTH_EXCEEDED"
		});
	}
	return {
		ast: {
			kind: "jsonc",
			raw,
			root: diagnostics.every((d) => d.severity !== "error") ? root : null
		},
		diagnostics
	};
}
function toDiagnostic(error, lineMap, tree) {
	const treeEnd = tree ? tree.offset + tree.length : 0;
	const isTrailingInput = error.error === ParseErrorCode.EndOfFileExpected || tree !== void 0 && error.error === ParseErrorCode.InvalidSymbol && error.offset >= treeEnd;
	return {
		line: lineMap.lineForOffset(error.offset),
		message: printParseErrorCode(error.error),
		severity: isTrailingInput ? "warning" : "error",
		code: isTrailingInput ? "OC_JSONC_TRAILING_INPUT" : "OC_JSONC_PARSE_FAILED"
	};
}
function nodeToJsoncValue(node, lineMap, depth) {
	if (depth > 256) throw new Error(`structural depth exceeded MAX_PARSE_DEPTH (256)`);
	const line = lineMap.lineForOffset(node.offset);
	switch (node.type) {
		case "object": return {
			kind: "object",
			line,
			entries: (node.children ?? []).flatMap((child) => {
				if (child.type !== "property") return [];
				const keyNode = child.children?.[0];
				const valueNode = child.children?.[1];
				if (!keyNode || !valueNode) return [];
				return [{
					key: String(keyNode.value),
					line: lineMap.lineForOffset(keyNode.offset),
					value: nodeToJsoncValue(valueNode, lineMap, depth + 1)
				}];
			})
		};
		case "array": return {
			kind: "array",
			line,
			items: (node.children ?? []).map((child) => nodeToJsoncValue(child, lineMap, depth + 1))
		};
		case "string": return {
			kind: "string",
			value: String(node.value),
			line
		};
		case "number": return {
			kind: "number",
			value: Number(node.value),
			line
		};
		case "boolean": return {
			kind: "boolean",
			value: Boolean(node.value),
			line
		};
		case "null": return {
			kind: "null",
			line
		};
		default: return {
			kind: "null",
			line
		};
	}
}
function createLineMap(raw) {
	const starts = [0];
	for (let i = 0; i < raw.length; i++) if (raw[i] === "\n") starts.push(i + 1);
	return { lineForOffset(offset) {
		let low = 0;
		let high = starts.length - 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if ((starts[mid] ?? 0) <= offset) low = mid + 1;
			else high = mid - 1;
		}
		return Math.max(1, high + 1);
	} };
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonl/parse.ts
function parseJsonl(raw) {
	const diagnostics = [];
	const crlfCount = (raw.match(/\r\n/g) ?? []).length;
	const lfCount = (raw.match(/\n/g) ?? []).length;
	const lineEnding = crlfCount > 0 && crlfCount * 2 >= lfCount ? "\r\n" : "\n";
	let body = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	body = body.replace(/\r\n/g, "\n");
	const lines = [];
	if (body.length === 0) return {
		ast: {
			kind: "jsonl",
			raw,
			lines,
			lineEnding
		},
		diagnostics
	};
	body.split("\n").forEach((lineText, idx) => {
		const lineNo = idx + 1;
		if (lineText.trim().length === 0) {
			lines.push({
				kind: "blank",
				line: lineNo,
				raw: lineText
			});
			return;
		}
		const r = parseJsonc(lineText);
		if (r.ast.root === null) {
			lines.push({
				kind: "malformed",
				line: lineNo,
				raw: lineText
			});
			diagnostics.push({
				line: lineNo,
				message: `line ${lineNo} could not be parsed as JSON`,
				severity: "warning",
				code: "OC_JSONL_LINE_MALFORMED"
			});
			return;
		}
		lines.push({
			kind: "value",
			line: lineNo,
			value: r.ast.root,
			raw: lineText
		});
	});
	return {
		ast: {
			kind: "jsonl",
			raw,
			lines,
			lineEnding
		},
		diagnostics
	};
}
//#endregion
//#region extensions/oc-path/src/oc-path/yaml/parse.ts
function parseYaml(raw) {
	const lineCounter = new LineCounter();
	const doc = parseDocument(raw, {
		keepSourceTokens: true,
		prettyErrors: false,
		lineCounter
	});
	const diagnostics = [];
	for (const w of doc.warnings) diagnostics.push({
		line: w.linePos?.[0]?.line ?? 1,
		message: w.message,
		severity: "warning",
		code: "OC_YAML_WARN"
	});
	for (const e of doc.errors) diagnostics.push({
		line: e.linePos?.[0]?.line ?? 1,
		message: e.message,
		severity: "error",
		code: "OC_YAML_PARSE_FAILED"
	});
	return {
		ast: {
			kind: "yaml",
			raw,
			doc,
			lineCounter
		},
		diagnostics
	};
}
//#endregion
//#region extensions/oc-path/src/oc-path/emit.ts
/**
* Emit the AST. In render mode, throws `OcEmitSentinelError` if any
* leaf string matches `REDACTED_SENTINEL`. In round-trip mode, echoes
* `ast.raw` verbatim (does not scan unless caller opts in via
* `acceptPreExistingSentinel: false`).
*/
function emitMd(ast, opts = {}) {
	const mode = opts.mode ?? "roundtrip";
	const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
	const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;
	if (mode === "roundtrip") {
		if (!acceptPreExisting && ast.raw.includes("__OPENCLAW_REDACTED__")) guardSentinel$1("__OPENCLAW_REDACTED__", `${guardPath}/[raw]`);
		return ast.raw;
	}
	const parts = [];
	if (ast.frontmatter.length > 0) {
		parts.push("---");
		for (const fm of ast.frontmatter) {
			guardSentinel$1(fm.value, `${guardPath}/[frontmatter]/${fm.key}`);
			parts.push(`${fm.key}: ${formatFrontmatterValue$2(fm.value)}`);
		}
		parts.push("---");
	}
	if (ast.preamble.length > 0) {
		guardSentinel$1(ast.preamble, `${guardPath}/[preamble]`);
		if (parts.length > 0) parts.push("");
		parts.push(ast.preamble);
	}
	for (const block of ast.blocks) {
		if (parts.length > 0) parts.push("");
		parts.push(`## ${block.heading}`);
		if (block.bodyText.length > 0) {
			guardSentinel$1(block.bodyText, `${guardPath}/${block.slug}/[body]`);
			for (const item of block.items) if (item.kv) guardSentinel$1(item.kv.value, `${guardPath}/${block.slug}/${item.slug}/${item.kv.key}`);
			parts.push(block.bodyText);
		}
	}
	return parts.join("\n");
}
function formatFrontmatterValue$2(value) {
	if (value.length === 0) return "\"\"";
	if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) return JSON.stringify(value);
	return value;
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonc/emit.ts
/**
* Emit a `JsoncAst` to bytes.
*
* Round-trip (default) echoes `ast.raw` verbatim — preserves comments
* and formatting. Sentinel guard fires only in render mode by default;
* round-trip trusts parsed bytes so a workspace file legitimately
* containing the sentinel literal isn't a global emit DoS. Callers
* that need pre-existing detection opt in via
* `acceptPreExistingSentinel: false`.
*
* @module @openclaw/oc-path/jsonc/emit
*/
function emitJsonc(ast, opts = {}) {
	const mode = opts.mode ?? "roundtrip";
	const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
	const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;
	if (mode === "roundtrip") {
		if (!acceptPreExisting && ast.raw.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/[raw]`);
		return ast.raw;
	}
	if (ast.root === null) return "";
	return renderValue$1(ast.root, guardPath, []);
}
function renderValue$1(value, guardPath, walked) {
	switch (value.kind) {
		case "object": return `{ ${value.entries.map((e) => `${JSON.stringify(e.key)}: ${renderValue$1(e.value, guardPath, [...walked, e.key])}`).join(", ")} }`;
		case "array": return `[ ${value.items.map((v, i) => renderValue$1(v, guardPath, [...walked, String(i)])).join(", ")} ]`;
		case "string":
			if (value.value.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/${walked.join("/")}`);
			return JSON.stringify(value.value);
		case "number": return String(value.value);
		case "boolean": return String(value.value);
		case "null": return "null";
	}
	return "";
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonl/emit.ts
function emitJsonl(ast, opts = {}) {
	const mode = opts.mode ?? "roundtrip";
	const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
	const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;
	if (mode === "roundtrip") {
		if (!acceptPreExisting && ast.raw.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/[raw]`);
		return ast.raw;
	}
	const out = [];
	for (const ln of ast.lines) {
		if (ln.kind === "blank" || ln.kind === "malformed") {
			if (!acceptPreExisting && ln.raw.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/L${ln.line}`);
			out.push(ln.raw);
			continue;
		}
		out.push(renderValue(ln.value, `${guardPath}/L${ln.line}`, []));
	}
	return out.join(ast.lineEnding ?? "\n");
}
function renderValue(value, guardPath, walked) {
	switch (value.kind) {
		case "object": return `{${value.entries.map((e) => `${JSON.stringify(e.key)}:${renderValue(e.value, guardPath, [...walked, e.key])}`).join(",")}}`;
		case "array": return `[${value.items.map((v, i) => renderValue(v, guardPath, [...walked, String(i)])).join(",")}]`;
		case "string":
			if (value.value.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/${walked.join("/")}`);
			return JSON.stringify(value.value);
		case "number": return String(value.value);
		case "boolean": return String(value.value);
		case "null": return "null";
	}
	return "";
}
//#endregion
//#region extensions/oc-path/src/oc-path/yaml/emit.ts
function emitYaml(ast, opts = {}) {
	const mode = opts.mode ?? "roundtrip";
	const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : "oc://";
	const acceptPreExisting = opts.acceptPreExistingSentinel ?? true;
	if (mode === "roundtrip") {
		if (!acceptPreExisting && ast.raw.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/[raw]`);
		return ast.raw;
	}
	const rendered = ast.doc.toString();
	if (rendered.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(`${guardPath}/[rendered]`);
	return rendered;
}
//#endregion
//#region extensions/oc-path/src/oc-path/edit.ts
function setMdOcPath(ast, path, newValue) {
	guardSentinel$1(newValue, formatOcPath(path));
	if (path.section === "[frontmatter]") {
		const key = path.item ?? path.field;
		if (key === void 0) return {
			ok: false,
			reason: "unresolved"
		};
		const idx = ast.frontmatter.findIndex((e) => e.key === key);
		if (idx === -1) return {
			ok: false,
			reason: "unresolved"
		};
		const existing = ast.frontmatter[idx];
		if (existing === void 0) return {
			ok: false,
			reason: "unresolved"
		};
		const newEntry = {
			...existing,
			value: newValue
		};
		const newFm = ast.frontmatter.slice();
		newFm[idx] = newEntry;
		return finalize$1({
			...ast,
			frontmatter: newFm
		});
	}
	if (path.section === void 0 || path.item === void 0 || path.field === void 0) return {
		ok: false,
		reason: "not-writable"
	};
	const sectionSlug = path.section.toLowerCase();
	const blockIdx = ast.blocks.findIndex((b) => b.slug === sectionSlug);
	if (blockIdx === -1) return {
		ok: false,
		reason: "unresolved"
	};
	const block = ast.blocks[blockIdx];
	if (block === void 0) return {
		ok: false,
		reason: "unresolved"
	};
	const itemSlug = path.item.toLowerCase();
	const itemIdx = block.items.findIndex((i) => i.slug === itemSlug);
	if (itemIdx === -1) return {
		ok: false,
		reason: "unresolved"
	};
	const item = block.items[itemIdx];
	if (item === void 0) return {
		ok: false,
		reason: "unresolved"
	};
	if (item.kv === void 0) return {
		ok: false,
		reason: "no-item-kv"
	};
	if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) return {
		ok: false,
		reason: "unresolved"
	};
	const newItem = {
		...item,
		kv: {
			key: item.kv.key,
			value: newValue
		}
	};
	const newItems = block.items.slice();
	newItems[itemIdx] = newItem;
	const newBlock = {
		...block,
		items: newItems,
		bodyText: rebuildBlockBody(block, newItems)
	};
	const newBlocks = ast.blocks.slice();
	newBlocks[blockIdx] = newBlock;
	return finalize$1({
		...ast,
		blocks: newBlocks
	});
}
function rebuildBlockBody(block, newItems) {
	let body = block.bodyText;
	for (let i = 0; i < newItems.length; i++) {
		const newItem = newItems[i];
		const oldItem = block.items[i];
		if (newItem === void 0 || oldItem === void 0) continue;
		if (newItem.kv === void 0 || oldItem.kv === void 0) continue;
		if (newItem.kv.value === oldItem.kv.value) continue;
		const re = new RegExp(`^(\\s*-\\s*${escapeRegex(oldItem.kv.key)}\\s*:\\s*).*$`, "m");
		body = body.replace(re, `$1${newItem.kv.value}`);
	}
	return body;
}
function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function finalize$1(ast) {
	const parts = [];
	if (ast.frontmatter.length > 0) {
		parts.push("---");
		for (const fm of ast.frontmatter) parts.push(`${fm.key}: ${formatFrontmatterValue$1(fm.value)}`);
		parts.push("---");
	}
	if (ast.preamble.length > 0) {
		if (parts.length > 0) parts.push("");
		parts.push(ast.preamble);
	}
	for (const block of ast.blocks) {
		if (parts.length > 0) parts.push("");
		parts.push(`## ${block.heading}`);
		if (block.bodyText.length > 0) parts.push(block.bodyText);
	}
	return {
		ok: true,
		ast: {
			...ast,
			raw: parts.join("\n")
		}
	};
}
function formatFrontmatterValue$1(value) {
	if (value.length === 0) return "\"\"";
	if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) return JSON.stringify(value);
	return value;
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonc/edit.ts
function setJsoncOcPath(ast, path, newValue) {
	if (ast.root === null) return {
		ok: false,
		reason: "no-root"
	};
	const segments = resolveEditSegments(ast.root, pathSegments$1(path));
	if (segments === null) return {
		ok: false,
		reason: "unresolved"
	};
	guardSentinel(newValue, `oc://${path.file}/${segments.join("/")}`);
	const edits = modify(ast.raw, segments, jsoncValueToJson(newValue), {
		formattingOptions: {
			insertSpaces: true,
			tabSize: 2
		},
		isArrayInsertion: false
	});
	if (edits.length === 0) return {
		ok: false,
		reason: "unresolved"
	};
	const reparsed = parseJsonc(applyEdits(ast.raw, edits));
	if (reparsed.ast.root === null) return {
		ok: false,
		reason: "unresolved"
	};
	return {
		ok: true,
		ast: reparsed.ast
	};
}
function guardSentinel(value, guardPath) {
	if (value.kind === "string") {
		if (value.value.includes("__OPENCLAW_REDACTED__")) throw new OcEmitSentinelError(guardPath);
		return;
	}
	if (value.kind === "array") {
		value.items.forEach((item, index) => guardSentinel(item, `${guardPath}/${index}`));
		return;
	}
	if (value.kind === "object") value.entries.forEach((entry) => guardSentinel(entry.value, `${guardPath}/${entry.key}`));
}
function pathSegments$1(path) {
	const out = [];
	const collect = (slot) => {
		if (slot === void 0) return;
		for (const segment of splitRespectingBrackets(slot, ".")) out.push(isQuotedSeg(segment) ? unquoteSeg(segment) : segment);
	};
	collect(path.section);
	collect(path.item);
	collect(path.field);
	return out;
}
function resolveEditSegments(root, segments) {
	const out = [];
	let current = root;
	for (let segment of segments) {
		if (segment.length === 0) return null;
		if (isPositionalSeg(segment)) {
			const concrete = positionalForJsonc$1(current, segment);
			if (concrete !== null) segment = concrete;
		}
		if (current.kind === "object") {
			const entry = current.entries.find((candidate) => candidate.key === segment);
			if (!entry) return null;
			out.push(segment);
			current = entry.value;
			continue;
		}
		if (current.kind === "array") {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.items.length) return null;
			out.push(index);
			current = current.items[index];
			continue;
		}
		return null;
	}
	return out;
}
function positionalForJsonc$1(node, segment) {
	if (node.kind === "object") {
		const keys = node.entries.map((entry) => entry.key);
		return resolvePositionalSeg(segment, {
			indexable: false,
			size: keys.length,
			keys
		});
	}
	if (node.kind === "array") return resolvePositionalSeg(segment, {
		indexable: true,
		size: node.items.length
	});
	return null;
}
function jsoncValueToJson(value) {
	switch (value.kind) {
		case "object": return Object.fromEntries(value.entries.map((entry) => [entry.key, jsoncValueToJson(entry.value)]));
		case "array": return value.items.map(jsoncValueToJson);
		case "string": return value.value;
		case "number": return value.value;
		case "boolean": return value.value;
		case "null": return null;
	}
	return null;
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonc/resolve-value.ts
function resolveJsoncValueOcPath(root, segments) {
	let current = root;
	let lastEntry = null;
	const walked = [];
	for (let seg of segments) {
		if (seg.length === 0) return null;
		if (isPositionalSeg(seg)) {
			const concrete = positionalForJsonc(current, seg);
			if (concrete !== null) seg = concrete;
		}
		walked.push(seg);
		if (current.kind === "object") {
			const entry = current.entries.find((e) => e.key === seg);
			if (entry === void 0) return null;
			lastEntry = entry;
			current = entry.value;
			continue;
		}
		if (current.kind === "array") {
			const idx = Number(seg);
			if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) return null;
			lastEntry = null;
			const item = current.items[idx];
			if (item === void 0) return null;
			current = item;
			continue;
		}
		return null;
	}
	if (lastEntry !== null && current === lastEntry.value) return {
		kind: "object-entry",
		node: lastEntry,
		path: walked
	};
	return {
		kind: "value",
		node: current,
		path: walked
	};
}
function positionalForJsonc(node, seg) {
	if (node.kind === "object") {
		const keys = node.entries.map((e) => e.key);
		return resolvePositionalSeg(seg, {
			indexable: false,
			size: keys.length,
			keys
		});
	}
	if (node.kind === "array") return resolvePositionalSeg(seg, {
		indexable: true,
		size: node.items.length
	});
	return null;
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonc/resolve.ts
function resolveJsoncOcPath(ast, path) {
	if (ast.root === null) return null;
	const segments = [];
	const collect = (slot) => {
		if (slot === void 0) return;
		for (const s of splitRespectingBrackets(slot, ".")) segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
	};
	collect(path.section);
	collect(path.item);
	collect(path.field);
	if (segments.length === 0) return {
		kind: "root",
		node: ast
	};
	return resolveJsoncValueOcPath(ast.root, segments);
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonl/edit.ts
function setJsonlOcPath(ast, path, newValue) {
	const head = path.section;
	if (head === void 0) return {
		ok: false,
		reason: "unresolved"
	};
	const lineIdx = pickLineIndex(ast, head);
	if (lineIdx === -1) return {
		ok: false,
		reason: "unresolved"
	};
	const target = ast.lines[lineIdx];
	if (target === void 0) return {
		ok: false,
		reason: "unresolved"
	};
	if (path.item === void 0 && path.field === void 0) {
		if (target.kind !== "value") return {
			ok: false,
			reason: "not-a-value-line"
		};
		return finalize(ast, lineIdx, {
			kind: "value",
			line: target.line,
			value: newValue,
			raw: target.raw
		}, path.file);
	}
	if (target.kind !== "value") return {
		ok: false,
		reason: "not-a-value-line"
	};
	const segments = [];
	if (path.item !== void 0) segments.push(...splitRespectingBrackets(path.item, "."));
	if (path.field !== void 0) segments.push(...splitRespectingBrackets(path.field, "."));
	const replaced = replaceAt(target.value, segments, 0, newValue);
	if (replaced === null) return {
		ok: false,
		reason: "unresolved"
	};
	return finalize(ast, lineIdx, {
		kind: "value",
		line: target.line,
		value: replaced,
		raw: target.raw
	}, path.file);
}
function replaceAt(current, segments, i, newValue) {
	const seg = segments[i];
	if (seg === void 0) return newValue;
	if (seg.length === 0) return null;
	if (current.kind === "object") {
		let segNorm = seg;
		if (isPositionalSeg(seg)) {
			const resolved = resolvePositionalSeg(seg, {
				indexable: false,
				size: current.entries.length,
				keys: current.entries.map((e) => e.key)
			});
			if (resolved === null) return null;
			segNorm = resolved;
		}
		const lookupKey = isQuotedSeg(segNorm) ? unquoteSeg(segNorm) : segNorm;
		const idx = current.entries.findIndex((e) => e.key === lookupKey);
		if (idx === -1) return null;
		const child = current.entries[idx];
		if (child === void 0) return null;
		const replacedChild = replaceAt(child.value, segments, i + 1, newValue);
		if (replacedChild === null) return null;
		const newEntry = {
			...child,
			value: replacedChild
		};
		const newEntries = current.entries.slice();
		newEntries[idx] = newEntry;
		return {
			kind: "object",
			entries: newEntries,
			...current.line !== void 0 ? { line: current.line } : {}
		};
	}
	if (current.kind === "array") {
		let segNorm = seg;
		if (isPositionalSeg(seg)) {
			const resolved = resolvePositionalSeg(seg, {
				indexable: true,
				size: current.items.length
			});
			if (resolved === null) return null;
			segNorm = resolved;
		}
		const idx = Number(segNorm);
		if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) return null;
		const child = current.items[idx];
		if (child === void 0) return null;
		const replacedChild = replaceAt(child, segments, i + 1, newValue);
		if (replacedChild === null) return null;
		const newItems = current.items.slice();
		newItems[idx] = replacedChild;
		return {
			kind: "array",
			items: newItems,
			...current.line !== void 0 ? { line: current.line } : {}
		};
	}
	return null;
}
function pickLineIndex(ast, addr) {
	if (addr === "$first") return ast.lines.findIndex((line) => line.kind === "value");
	if (addr === "$last") {
		for (let i = ast.lines.length - 1; i >= 0; i--) if (ast.lines[i]?.kind === "value") return i;
		return -1;
	}
	const m = /^L(\d+)$/.exec(addr);
	if (m === null || m[1] === void 0) return -1;
	const target = Number(m[1]);
	return ast.lines.findIndex((l) => l.line === target);
}
function finalize(ast, lineIdx, newLine, fileName) {
	const newLines = ast.lines.slice();
	newLines[lineIdx] = newLine;
	const next = {
		kind: "jsonl",
		raw: "",
		lines: newLines,
		...ast.lineEnding !== void 0 ? { lineEnding: ast.lineEnding } : {}
	};
	const rendered = emitJsonl(next, fileName !== void 0 ? {
		mode: "render",
		fileNameForGuard: fileName
	} : { mode: "render" });
	return {
		ok: true,
		ast: {
			...next,
			raw: rendered
		}
	};
}
/** Append a value as the next line. Line numbers are substrate-assigned. */
function appendJsonlOcPath(ast, value) {
	const newLine = {
		kind: "value",
		line: ast.lines.length === 0 ? 1 : (ast.lines[ast.lines.length - 1]?.line ?? 0) + 1,
		value,
		raw: ""
	};
	const next = {
		kind: "jsonl",
		raw: "",
		lines: [...ast.lines, newLine],
		...ast.lineEnding !== void 0 ? { lineEnding: ast.lineEnding } : {}
	};
	const rendered = emitJsonl(next, { mode: "render" });
	return {
		...next,
		raw: rendered
	};
}
//#endregion
//#region extensions/oc-path/src/oc-path/jsonl/resolve.ts
function resolveJsonlOcPath(ast, path) {
	const head = path.section;
	if (head === void 0) return {
		kind: "root",
		node: ast
	};
	const lineEntry = pickLine$1(ast, head);
	if (lineEntry === null) return null;
	if (path.item === void 0 && path.field === void 0) return {
		kind: "line",
		node: lineEntry
	};
	if (lineEntry.kind !== "value") return null;
	const segments = [];
	if (path.item !== void 0) for (const s of splitRespectingBrackets(path.item, ".")) segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
	if (path.field !== void 0) for (const s of splitRespectingBrackets(path.field, ".")) segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
	const match = resolveJsoncValueOcPath(lineEntry.value, segments);
	if (match === null) return null;
	if (match.kind === "object-entry") return {
		kind: "object-entry",
		node: match.node,
		line: lineEntry.line,
		path: match.path
	};
	return {
		kind: "value",
		node: match.node,
		line: lineEntry.line,
		path: match.path
	};
}
function pickLine$1(ast, addr) {
	if (addr === "$first") {
		for (const l of ast.lines) if (l.kind === "value") return l;
		return null;
	}
	if (addr === "$last") {
		for (let i = ast.lines.length - 1; i >= 0; i--) {
			const l = ast.lines[i];
			if (l !== void 0 && l.kind === "value") return l;
		}
		return null;
	}
	const m = /^L(\d+)$/.exec(addr);
	if (m === null || m[1] === void 0) return null;
	const target = Number(m[1]);
	for (const l of ast.lines) if (l.line === target) return l;
	return null;
}
//#endregion
//#region extensions/oc-path/src/oc-path/resolve.ts
/**
* Resolve. Slugs match case-insensitively. `[frontmatter]` is a
* literal section sentinel; the frontmatter key sits at `item` (or
* `field` for 4-segment callers).
*/
function resolveMdOcPath(ast, path) {
	if (path.section === "[frontmatter]") {
		const key = path.item ?? path.field;
		if (key === void 0) return null;
		const entry = ast.frontmatter.find((e) => e.key === key);
		if (entry === void 0) return null;
		return {
			kind: "frontmatter",
			node: entry
		};
	}
	if (path.section === void 0) return {
		kind: "root",
		node: ast
	};
	const block = ast.blocks.find((b) => b.slug === path.section.toLowerCase());
	if (block === void 0) return null;
	if (path.item === void 0) return {
		kind: "block",
		node: block
	};
	let item;
	if (isOrdinalSeg(path.item)) {
		const n = parseOrdinalSeg(path.item);
		if (n === null || n < 0 || n >= block.items.length) return null;
		item = block.items[n];
	} else if (isPositionalSeg(path.item)) {
		const concrete = resolvePositionalSeg(path.item, {
			indexable: true,
			size: block.items.length
		});
		if (concrete === null) return null;
		item = block.items[Number(concrete)];
	} else item = block.items.find((i) => i.slug === path.item.toLowerCase());
	if (item === void 0) return null;
	if (path.field === void 0) return {
		kind: "item",
		node: item,
		block
	};
	if (item.kv === void 0) return null;
	if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) return null;
	return {
		kind: "item-field",
		node: item,
		block,
		value: item.kv.value
	};
}
//#endregion
//#region extensions/oc-path/src/oc-path/yaml/edit.ts
function setYamlOcPath(ast, path, newValue) {
	if (hasYamlParseErrors(ast)) return {
		ok: false,
		reason: "parse-error"
	};
	if (ast.doc.contents === null) return {
		ok: false,
		reason: "no-root"
	};
	guardYamlSentinel(newValue, formatOcPath(path));
	const rawSegments = pathSegments(path);
	if (rawSegments.length === 0) return {
		ok: false,
		reason: "unresolved"
	};
	const segments = resolvePositionalSegments(ast.doc.contents, rawSegments);
	if (segments === null) return {
		ok: false,
		reason: "unresolved"
	};
	if (!ast.doc.hasIn(segments)) return {
		ok: false,
		reason: "unresolved"
	};
	const { doc: cloned, lineCounter } = cloneDoc(ast.doc);
	cloned.setIn(segments, newValue);
	return {
		ok: true,
		ast: {
			kind: "yaml",
			raw: cloned.toString(),
			doc: cloned,
			lineCounter
		}
	};
}
function insertYamlOcPath(ast, parentPath, marker, newValue) {
	if (hasYamlParseErrors(ast)) return {
		ok: false,
		reason: "parse-error"
	};
	if (ast.doc.contents === null) return {
		ok: false,
		reason: "no-root"
	};
	guardYamlSentinel(newValue, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);
	const rawParentSegments = pathSegments(parentPath);
	const segments = rawParentSegments.length === 0 ? rawParentSegments : resolvePositionalSegments(ast.doc.contents, rawParentSegments);
	if (segments === null) return {
		ok: false,
		reason: "unresolved"
	};
	const { doc: cloned, lineCounter } = cloneDoc(ast.doc);
	const parent = segments.length === 0 ? cloned.contents : cloned.getIn(segments, false);
	if (parent === void 0 || parent === null) return {
		ok: false,
		reason: "unresolved"
	};
	if (isMap(parent)) {
		if (typeof marker !== "object" || marker.kind !== "keyed") return {
			ok: false,
			reason: "unresolved"
		};
		guardSentinel$1(marker.key, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);
		if (cloned.hasIn([...segments, marker.key])) return {
			ok: false,
			reason: "unresolved"
		};
		cloned.setIn([...segments, marker.key], newValue);
		return {
			ok: true,
			ast: {
				kind: "yaml",
				raw: cloned.toString(),
				doc: cloned,
				lineCounter
			}
		};
	}
	if (isSeq(parent)) {
		if (typeof marker === "object" && marker.kind === "keyed") return {
			ok: false,
			reason: "unresolved"
		};
		if (marker === "+") cloned.addIn(segments, newValue);
		else if (typeof marker === "object" && marker.kind === "indexed") {
			const idx = Math.min(marker.index, parent.items.length);
			parent.items.splice(idx, 0, cloned.createNode(newValue));
		}
		return {
			ok: true,
			ast: {
				kind: "yaml",
				raw: cloned.toString(),
				doc: cloned,
				lineCounter
			}
		};
	}
	return {
		ok: false,
		reason: "unresolved"
	};
}
function resolvePositionalSegments(root, segments) {
	const out = [];
	let node = root;
	for (const seg of segments) {
		if (node === null) return null;
		let segNorm = seg;
		if (isPositionalSeg(seg)) {
			const concrete = positionalForYamlNode$1(node, seg);
			if (concrete === null) return null;
			segNorm = concrete;
		}
		out.push(segNorm);
		if (isMap(node)) {
			node = node.items.find((p) => {
				const k = isScalar(p.key) ? p.key.value : p.key;
				return String(k) === segNorm;
			})?.value ?? null;
			continue;
		}
		if (isSeq(node)) {
			const idx = Number(segNorm);
			if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) return null;
			node = node.items[idx] ?? null;
			continue;
		}
		node = null;
	}
	return out;
}
function positionalForYamlNode$1(node, seg) {
	if (isMap(node)) {
		const keys = node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
		return resolvePositionalSeg(seg, {
			indexable: false,
			size: keys.length,
			keys
		});
	}
	if (isSeq(node)) {
		const items = node.items;
		return resolvePositionalSeg(seg, {
			indexable: true,
			size: items.length
		});
	}
	return null;
}
function pathSegments(path) {
	const segs = [];
	const collect = (slot) => {
		if (slot === void 0) return;
		for (const sub of splitRespectingBrackets(slot, ".")) segs.push(isQuotedSeg(sub) ? unquoteSeg(sub) : sub);
	};
	collect(path.section);
	collect(path.item);
	collect(path.field);
	return segs;
}
function formatInsertionMarker(marker) {
	if (marker === "+") return "+";
	return marker.kind === "keyed" ? `+${marker.key}` : `+${marker.index}`;
}
function guardYamlSentinel(value, ocPath) {
	guardSentinel$1(value, ocPath);
	if (Array.isArray(value)) {
		value.forEach((item, index) => guardYamlSentinel(item, `${ocPath}/${index}`));
		return;
	}
	if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
		guardSentinel$1(key, `${ocPath}/${key}`);
		guardYamlSentinel(child, `${ocPath}/${key}`);
	}
}
function hasYamlParseErrors(ast) {
	return ast.doc.errors.length > 0;
}
function cloneDoc(doc) {
	const lineCounter = new LineCounter();
	return {
		doc: parseDocument(doc.toString(), {
			keepSourceTokens: true,
			prettyErrors: false,
			lineCounter
		}),
		lineCounter
	};
}
//#endregion
//#region extensions/oc-path/src/oc-path/yaml/resolve.ts
function resolveYamlOcPath(ast, path) {
	const segments = [];
	if (path.section !== void 0) for (const s of splitRespectingBrackets(path.section, ".")) segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
	if (path.item !== void 0) for (const s of splitRespectingBrackets(path.item, ".")) segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
	if (path.field !== void 0) for (const s of splitRespectingBrackets(path.field, ".")) segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
	if (segments.length === 0) return {
		kind: "root",
		node: ast
	};
	const root = ast.doc.contents;
	if (root === null) return null;
	return walkNode(root, segments, 0, []);
}
function walkNode(node, segments, i, walked) {
	if (node === null) return null;
	let seg = segments[i];
	if (seg === void 0) {
		if (isMap(node)) return {
			kind: "map",
			path: walked
		};
		if (isSeq(node)) return {
			kind: "seq",
			path: walked
		};
		if (isScalar(node)) return {
			kind: "scalar",
			value: node.value,
			path: walked
		};
		return null;
	}
	if (seg.length === 0) return null;
	if (isPositionalSeg(seg)) {
		const concrete = positionalForYaml(node, seg);
		if (concrete !== null) seg = concrete;
	}
	if (isMap(node)) {
		const pair = node.items.find((p) => {
			const k = isScalar(p.key) ? p.key.value : p.key;
			return String(k) === seg;
		});
		if (pair === void 0) return null;
		const childWalked = [...walked, seg];
		if (i === segments.length - 1) {
			const child = pair.value;
			if (isScalar(child)) return {
				kind: "pair",
				key: seg,
				value: child.value,
				path: childWalked
			};
			return walkNode(child, segments, i + 1, childWalked);
		}
		return walkNode(pair.value, segments, i + 1, childWalked);
	}
	if (isSeq(node)) {
		const idx = Number(seg);
		if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) return null;
		const child = node.items[idx];
		return walkNode(child, segments, i + 1, [...walked, seg]);
	}
	return null;
}
function positionalForYaml(node, seg) {
	if (isMap(node)) {
		const keys = node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
		return resolvePositionalSeg(seg, {
			indexable: false,
			size: keys.length,
			keys
		});
	}
	if (isSeq(node)) {
		const items = node.items;
		return resolvePositionalSeg(seg, {
			indexable: true,
			size: items.length
		});
	}
	return null;
}
//#endregion
//#region extensions/oc-path/src/oc-path/universal.ts
/**
* Universal `setOcPath` / `resolveOcPath` / `detectInsertion`.
* Addressing is universal; encoding is per-kind. Callers pass any AST
* + path + value; the substrate dispatches on `ast.kind` and coerces
* the value based on the AST shape at the resolution point. Wildcard,
* union, and predicate expansion belong to `findOcPaths`; `resolveOcPath`
* and `setOcPath` require concrete paths.
*
*   oc://FILE/section/item/field   → leaf address
*   oc://FILE/section/+            → end-insertion
*   oc://FILE/section/+key         → keyed insertion
*   oc://FILE/section/+0           → indexed insertion
*   oc://FILE/+                    → file-root insertion
*
* @module @openclaw/oc-path/universal
*/
function detectInsertion(path) {
	const segments = [];
	if (path.section !== void 0) segments.push({
		slot: "section",
		value: path.section
	});
	if (path.item !== void 0) segments.push({
		slot: "item",
		value: path.item
	});
	if (path.field !== void 0) segments.push({
		slot: "field",
		value: path.field
	});
	if (segments.length === 0) return null;
	const last = segments[segments.length - 1];
	if (!last.value.startsWith("+")) return null;
	const rest = last.value.slice(1);
	const marker = rest.length === 0 ? "+" : /^\d+$/.test(rest) ? {
		kind: "indexed",
		index: Number(rest)
	} : {
		kind: "keyed",
		key: rest
	};
	return {
		parentPath: {
			file: path.file,
			...last.slot !== "section" && path.section !== void 0 ? { section: path.section } : {},
			...last.slot !== "item" && path.item !== void 0 ? { item: path.item } : {},
			...last.slot !== "field" && path.field !== void 0 ? { field: path.field } : {},
			...path.session !== void 0 ? { session: path.session } : {}
		},
		marker
	};
}
/** Resolve an `OcPath` against any AST. Throws on wildcard patterns. */
function resolveOcPath(ast, path) {
	if (hasWildcard(path)) throw new OcPathError(`resolveOcPath received a wildcard pattern; use findOcPaths instead: ${formatOcPath(path)}`, formatOcPath(path), "OC_PATH_WILDCARD_IN_RESOLVE");
	const insertion = detectInsertion(path);
	if (insertion !== null) return resolveInsertion(ast, insertion);
	switch (ast.kind) {
		case "md": return resolveMdToUniversal(ast, path);
		case "jsonc": return resolveJsoncToUniversal(ast, path);
		case "jsonl": return resolveJsonlToUniversal(ast, path);
		case "yaml": return resolveYamlToUniversal(ast, path);
	}
	return null;
}
function resolveMdToUniversal(ast, path) {
	const m = resolveMdOcPath(ast, path);
	if (m === null) return null;
	switch (m.kind) {
		case "root": return {
			kind: "root",
			ast,
			line: 1
		};
		case "frontmatter": return {
			kind: "leaf",
			valueText: m.node.value,
			leafType: "string",
			line: m.node.line
		};
		case "block": return {
			kind: "node",
			descriptor: "md-block",
			line: m.node.line
		};
		case "item": return {
			kind: "node",
			descriptor: "md-item",
			line: m.node.line
		};
		case "item-field": return {
			kind: "leaf",
			valueText: m.value,
			leafType: "string",
			line: m.node.line
		};
	}
	return null;
}
function resolveJsoncToUniversal(ast, path) {
	const m = resolveJsoncOcPath(ast, path);
	if (m === null) return null;
	if (m.kind === "root") return {
		kind: "root",
		ast,
		line: 1
	};
	if (m.kind === "object-entry") return jsoncValueToMatch(m.node.value, m.node.line);
	return jsoncValueToMatch(m.node, m.node.line ?? 1);
}
function jsoncValueToMatch(value, line) {
	switch (value.kind) {
		case "object": return {
			kind: "node",
			descriptor: "jsonc-object",
			line
		};
		case "array": return {
			kind: "node",
			descriptor: "jsonc-array",
			line
		};
		case "string": return {
			kind: "leaf",
			valueText: value.value,
			leafType: "string",
			line
		};
		case "number": return {
			kind: "leaf",
			valueText: String(value.value),
			leafType: "number",
			line
		};
		case "boolean": return {
			kind: "leaf",
			valueText: String(value.value),
			leafType: "boolean",
			line
		};
		case "null": return {
			kind: "leaf",
			valueText: "null",
			leafType: "null",
			line
		};
	}
	return {
		kind: "leaf",
		valueText: "null",
		leafType: "null",
		line
	};
}
function resolveJsonlToUniversal(ast, path) {
	const m = resolveJsonlOcPath(ast, path);
	if (m === null) return null;
	if (m.kind === "root") return {
		kind: "root",
		ast,
		line: 1
	};
	if (m.kind === "line") return {
		kind: "node",
		descriptor: "jsonl-line",
		line: m.node.line
	};
	if (m.kind === "object-entry") return jsoncValueToMatch(m.node.value, m.line);
	return jsoncValueToMatch(m.node, m.line);
}
function resolveYamlToUniversal(ast, path) {
	const m = resolveYamlOcPath(ast, path);
	if (m === null) return null;
	switch (m.kind) {
		case "root": return {
			kind: "root",
			ast,
			line: 1
		};
		case "scalar": return yamlScalarToMatch(m.value, yamlLine(ast, m.path));
		case "pair": return yamlScalarToMatch(m.value, yamlLine(ast, m.path));
		case "map": return {
			kind: "node",
			descriptor: "yaml-map",
			line: yamlLine(ast, m.path)
		};
		case "seq": return {
			kind: "node",
			descriptor: "yaml-seq",
			line: yamlLine(ast, m.path)
		};
	}
	return null;
}
function yamlScalarToMatch(value, line) {
	if (typeof value === "number") return {
		kind: "leaf",
		valueText: String(value),
		leafType: "number",
		line
	};
	if (typeof value === "boolean") return {
		kind: "leaf",
		valueText: String(value),
		leafType: "boolean",
		line
	};
	if (value === null) return {
		kind: "leaf",
		valueText: "null",
		leafType: "null",
		line
	};
	return {
		kind: "leaf",
		valueText: yamlScalarToText$1(value),
		leafType: "string",
		line
	};
}
function yamlScalarToText$1(value) {
	if (typeof value === "string") return value;
	if (typeof value === "bigint" || typeof value === "symbol") return value.toString();
	if (value instanceof Date) return value.toISOString();
	return JSON.stringify(value) ?? "";
}
function yamlLine(ast, path) {
	let node = ast.doc.contents;
	for (const segment of path) {
		if (node === null || typeof node !== "object") break;
		const getter = node;
		const index = Number(segment);
		node = Number.isInteger(index) ? getter.get?.(index, true) : getter.get?.(segment, true);
	}
	const range = node?.range;
	if (range === void 0) return 1;
	return ast.lineCounter.linePos(range[0]).line;
}
function resolveInsertion(ast, info) {
	switch (ast.kind) {
		case "md": return resolveMdInsertion(ast, info);
		case "jsonc": return resolveJsoncInsertion(ast, info);
		case "jsonl": return resolveJsonlInsertion(ast, info);
		case "yaml": return resolveYamlInsertion(ast, info);
	}
	return null;
}
function resolveMdInsertion(ast, info) {
	const p = info.parentPath;
	if (p.section === void 0) return {
		kind: "insertion-point",
		container: "md-file",
		line: 1
	};
	if (p.section === "[frontmatter]") return {
		kind: "insertion-point",
		container: "md-frontmatter",
		line: 1
	};
	if (p.item === void 0 && p.field === void 0) {
		const m = resolveMdOcPath(ast, p);
		if (m === null || m.kind !== "block") return null;
		return {
			kind: "insertion-point",
			container: "md-section",
			line: m.node.line
		};
	}
	return null;
}
function resolveJsoncInsertion(ast, info) {
	const m = resolveJsoncOcPath(ast, info.parentPath);
	if (m === null) return null;
	let containerNode;
	if (m.kind === "root") {
		if (ast.root === null) return null;
		containerNode = ast.root;
	} else if (m.kind === "object-entry") containerNode = m.node.value;
	else containerNode = m.node;
	const line = containerNode.line ?? 1;
	if (containerNode.kind === "object") return {
		kind: "insertion-point",
		container: "jsonc-object",
		line
	};
	if (containerNode.kind === "array") return {
		kind: "insertion-point",
		container: "jsonc-array",
		line
	};
	return null;
}
function resolveJsonlInsertion(ast, info) {
	if (info.parentPath.section !== void 0) return null;
	return {
		kind: "insertion-point",
		container: "jsonl-file",
		line: (ast.lines.length > 0 ? ast.lines[ast.lines.length - 1].line : 0) + 1
	};
}
function resolveYamlInsertion(ast, info) {
	const m = resolveYamlOcPath(ast, info.parentPath);
	if (m === null) return null;
	switch (m.kind) {
		case "root": {
			const root = ast.doc.contents;
			if (isMap(root)) return {
				kind: "insertion-point",
				container: "yaml-map",
				line: 1
			};
			if (isSeq(root)) return {
				kind: "insertion-point",
				container: "yaml-seq",
				line: 1
			};
			return null;
		}
		case "map": return {
			kind: "insertion-point",
			container: "yaml-map",
			line: yamlLine(ast, m.path)
		};
		case "seq": return {
			kind: "insertion-point",
			container: "yaml-seq",
			line: yamlLine(ast, m.path)
		};
		case "pair":
		case "scalar": return null;
	}
	return null;
}
/**
* Replace or insert at `path`. Coerces value at leaves based on the
* existing AST shape; for insertion paths value is parsed as
* kind-appropriate content (JSON for jsonc/jsonl; raw text for md).
* Sentinel-guard violations throw `OcEmitSentinelError`.
*/
function setOcPath(ast, path, value) {
	if (hasWildcard(path)) return {
		ok: false,
		reason: "wildcard-not-allowed",
		detail: "setOcPath requires a concrete path; use findOcPaths to enumerate matches first"
	};
	const insertion = detectInsertion(path);
	if (insertion !== null) switch (ast.kind) {
		case "md": return setMdInsertion(ast, insertion, value);
		case "jsonc": return setJsoncInsertion(ast, insertion, value);
		case "jsonl": return setJsonlInsertion(ast, insertion, value);
		case "yaml": return setYamlInsertion(ast, insertion, value);
	}
	switch (ast.kind) {
		case "md": {
			const r = setMdOcPath(ast, path, value);
			return r.ok ? {
				ok: true,
				ast: r.ast
			} : {
				ok: false,
				reason: r.reason
			};
		}
		case "jsonc": return setStructuredLeaf(ast, path, value, resolveJsoncOcPath, setJsoncOcPath);
		case "jsonl": return setStructuredLeaf(ast, path, value, resolveJsonlOcPath, setJsonlOcPath, () => {
			const parsed = tryParseJson(value);
			if (parsed === void 0) return {
				ok: false,
				reason: "parse-error",
				detail: "line replacement requires JSON value"
			};
			const r = setJsonlOcPath(ast, path, jsonToJsoncValue(parsed));
			return r.ok ? {
				ok: true,
				ast: r.ast
			} : {
				ok: false,
				reason: r.reason
			};
		});
		case "yaml": return setYamlLeaf(ast, path, value);
	}
	return {
		ok: false,
		reason: "not-writable"
	};
}
function setStructuredLeaf(ast, path, value, resolve, set, onLine) {
	const existing = resolve(ast, path);
	if (existing === null) return {
		ok: false,
		reason: "unresolved"
	};
	if (existing.kind === "root") return {
		ok: false,
		reason: "not-writable",
		detail: "root replacement is not supported via setOcPath"
	};
	if (existing.kind === "line") return onLine !== void 0 ? onLine() : {
		ok: false,
		reason: "not-writable"
	};
	const leafValue = existing.kind === "object-entry" ? existing.node.value : existing.node;
	const coerced = coerceJsoncLeaf(value, leafValue);
	if (coerced === null) return {
		ok: false,
		reason: "parse-error",
		detail: `cannot coerce "${value}" to ${leafValue.kind}`
	};
	const r = set(ast, path, coerced);
	return r.ok ? {
		ok: true,
		ast: r.ast
	} : {
		ok: false,
		reason: r.reason
	};
}
function setMdInsertion(ast, info, value) {
	const p = info.parentPath;
	if (p.section === void 0) {
		if (info.marker !== "+") return {
			ok: false,
			reason: "not-writable",
			detail: "md file-level insertion uses bare `+`"
		};
		return {
			ok: true,
			ast: rebuildMdRaw({
				...ast,
				blocks: [...ast.blocks, {
					heading: value,
					slug: slugifyHeading(value),
					line: 0,
					bodyText: "",
					items: []
				}]
			})
		};
	}
	if (p.section === "[frontmatter]") {
		if (typeof info.marker !== "object" || info.marker.kind !== "keyed") return {
			ok: false,
			reason: "not-writable",
			detail: "md frontmatter insertion requires +key"
		};
		const key = info.marker.key;
		if (ast.frontmatter.some((e) => e.key === key)) return {
			ok: false,
			reason: "type-mismatch",
			detail: `frontmatter key '${key}' already exists; use set, not insert`
		};
		return {
			ok: true,
			ast: rebuildMdRaw({
				...ast,
				frontmatter: [...ast.frontmatter, {
					key,
					value,
					line: 0
				}]
			})
		};
	}
	if (p.item === void 0 && p.field === void 0) {
		if (info.marker !== "+") return {
			ok: false,
			reason: "not-writable",
			detail: "md section insertion uses bare `+`"
		};
		const blockIdx = ast.blocks.findIndex((b) => b.slug === p.section.toLowerCase());
		if (blockIdx === -1) return {
			ok: false,
			reason: "unresolved"
		};
		const block = ast.blocks[blockIdx];
		const kvMatch = /^([^:]+?)\s*:\s*(.+)$/.exec(value);
		const itemLine = `- ${value}`;
		const newItem = {
			text: value,
			slug: slugifyHeading(kvMatch ? kvMatch[1] : value),
			line: 0,
			...kvMatch !== null ? { kv: {
				key: kvMatch[1].trim(),
				value: kvMatch[2].trim()
			} } : {}
		};
		const newBodyText = block.bodyText.length === 0 ? itemLine : block.bodyText.replace(/\n*$/, "\n") + itemLine;
		const newBlocks = ast.blocks.slice();
		newBlocks[blockIdx] = {
			...block,
			items: [...block.items, newItem],
			bodyText: newBodyText
		};
		return {
			ok: true,
			ast: rebuildMdRaw({
				...ast,
				blocks: newBlocks
			})
		};
	}
	return {
		ok: false,
		reason: "not-writable"
	};
}
function setJsoncInsertion(ast, info, value) {
	const containerMatch = resolveJsoncInsertion(ast, info);
	if (containerMatch === null) return {
		ok: false,
		reason: "unresolved"
	};
	const parsed = tryParseJson(value);
	if (parsed === void 0) return {
		ok: false,
		reason: "parse-error",
		detail: "jsonc insertion requires JSON value"
	};
	const newJsoncValue = jsonToJsoncValue(parsed);
	if (containerMatch.kind !== "insertion-point") return {
		ok: false,
		reason: "unresolved"
	};
	if (containerMatch.container === "jsonc-array") {
		if (typeof info.marker === "object" && info.marker.kind === "keyed") return {
			ok: false,
			reason: "type-mismatch",
			detail: "cannot insert by key into array"
		};
		return mutateJsoncContainer(ast, info.parentPath, (container) => {
			if (container.kind !== "array") return null;
			const items = container.items.slice();
			if (info.marker === "+") items.push(newJsoncValue);
			else if (typeof info.marker === "object" && info.marker.kind === "indexed") {
				const idx = Math.min(info.marker.index, items.length);
				items.splice(idx, 0, newJsoncValue);
			}
			return {
				kind: "array",
				items,
				...container.line !== void 0 ? { line: container.line } : {}
			};
		});
	}
	if (typeof info.marker !== "object" || info.marker.kind !== "keyed") return {
		ok: false,
		reason: "type-mismatch",
		detail: "jsonc object insertion requires +key"
	};
	const key = info.marker.key;
	return mutateJsoncContainer(ast, info.parentPath, (container) => {
		if (container.kind !== "object") return null;
		if (container.entries.some((e) => e.key === key)) return null;
		const newEntry = {
			key,
			value: newJsoncValue,
			line: 0
		};
		return {
			kind: "object",
			entries: [...container.entries, newEntry],
			...container.line !== void 0 ? { line: container.line } : {}
		};
	});
}
function setJsonlInsertion(ast, info, value) {
	if (info.parentPath.section !== void 0 || info.marker !== "+") return {
		ok: false,
		reason: "not-writable",
		detail: "jsonl insertion only supports oc://FILE/+ append"
	};
	const parsed = tryParseJson(value);
	if (parsed === void 0) return {
		ok: false,
		reason: "parse-error",
		detail: "jsonl line append requires JSON value"
	};
	return {
		ok: true,
		ast: appendJsonlOcPath(ast, jsonToJsoncValue(parsed))
	};
}
function setYamlLeaf(ast, path, value) {
	if (ast.doc.errors.length > 0) return {
		ok: false,
		reason: "parse-error"
	};
	const existing = resolveYamlOcPath(ast, path);
	if (existing === null) return {
		ok: false,
		reason: "unresolved"
	};
	if (existing.kind === "root" || existing.kind === "map" || existing.kind === "seq") return {
		ok: false,
		reason: "not-writable"
	};
	const current = existing.value;
	const coerced = coerceYamlValue(value, current);
	if (coerced === void 0) return {
		ok: false,
		reason: "parse-error",
		detail: `cannot coerce "${value}" to ${typeof current}`
	};
	const r = setYamlOcPath(ast, path, coerced);
	return r.ok ? {
		ok: true,
		ast: r.ast
	} : {
		ok: false,
		reason: r.reason
	};
}
function setYamlInsertion(ast, info, value) {
	if (ast.doc.errors.length > 0) return {
		ok: false,
		reason: "parse-error"
	};
	const r = insertYamlOcPath(ast, info.parentPath, info.marker, parseYamlInput(value));
	return r.ok ? {
		ok: true,
		ast: r.ast
	} : {
		ok: false,
		reason: r.reason
	};
}
function coerceYamlValue(value, current) {
	if (typeof current === "number") {
		if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return;
		const n = Number(value);
		return Number.isFinite(n) ? n : void 0;
	}
	if (typeof current === "boolean") {
		if (value === "true") return true;
		if (value === "false") return false;
		return;
	}
	if (current === null) return value === "null" ? null : void 0;
	return value;
}
function parseYamlInput(value) {
	const parsed = tryParseJson(value);
	return parsed === void 0 ? value : parsed;
}
function coerceJsoncLeaf(valueText, existing) {
	const lineExt = existing.line !== void 0 ? { line: existing.line } : {};
	if (existing.kind === "string") return {
		kind: "string",
		value: valueText,
		...lineExt
	};
	if (existing.kind === "number") {
		const n = Number(valueText);
		return Number.isFinite(n) ? {
			kind: "number",
			value: n,
			...lineExt
		} : null;
	}
	if (existing.kind === "boolean") {
		if (valueText === "true") return {
			kind: "boolean",
			value: true,
			...lineExt
		};
		if (valueText === "false") return {
			kind: "boolean",
			value: false,
			...lineExt
		};
		return null;
	}
	if (existing.kind === "null") return valueText === "null" ? {
		kind: "null",
		...lineExt
	} : null;
	return null;
}
function tryParseJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return;
	}
}
function jsonToJsoncValue(v) {
	if (v === null) return { kind: "null" };
	if (typeof v === "string") return {
		kind: "string",
		value: v
	};
	if (typeof v === "number") return {
		kind: "number",
		value: v
	};
	if (typeof v === "boolean") return {
		kind: "boolean",
		value: v
	};
	if (Array.isArray(v)) return {
		kind: "array",
		items: v.map(jsonToJsoncValue)
	};
	if (typeof v === "object") return {
		kind: "object",
		entries: Object.entries(v).map(([key, value]) => ({
			key,
			value: jsonToJsoncValue(value),
			line: 0
		}))
	};
	throw new Error(`unsupported JSON value type: ${typeof v}`);
}
function mutateJsoncContainer(ast, parentPath, mutate) {
	if (ast.root === null) return {
		ok: false,
		reason: "no-root"
	};
	const segments = [];
	if (parentPath.section !== void 0) segments.push(...splitRespectingBrackets(parentPath.section, "."));
	if (parentPath.item !== void 0) segments.push(...splitRespectingBrackets(parentPath.item, "."));
	if (parentPath.field !== void 0) segments.push(...splitRespectingBrackets(parentPath.field, "."));
	const newRoot = segments.length === 0 ? mutate(ast.root) : mutateAt(ast.root, segments, 0, mutate);
	if (newRoot === null) return {
		ok: false,
		reason: "unresolved"
	};
	const next = {
		kind: "jsonc",
		raw: "",
		root: newRoot
	};
	return {
		ok: true,
		ast: {
			...next,
			raw: emitJsonc(next, { mode: "render" })
		}
	};
}
function mutateAt(current, segments, i, mutate) {
	const seg = segments[i];
	if (seg === void 0) return mutate(current);
	if (seg.length === 0) return null;
	if (current.kind === "object") {
		const lookupKey = isQuotedSeg(seg) ? unquoteSeg(seg) : seg;
		const idx = current.entries.findIndex((e) => e.key === lookupKey);
		if (idx === -1) return null;
		const child = current.entries[idx];
		const replaced = mutateAt(child.value, segments, i + 1, mutate);
		if (replaced === null) return null;
		const newEntries = current.entries.slice();
		newEntries[idx] = {
			...child,
			value: replaced
		};
		return {
			kind: "object",
			entries: newEntries,
			...current.line !== void 0 ? { line: current.line } : {}
		};
	}
	if (current.kind === "array") {
		const idx = Number(seg);
		if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) return null;
		const child = current.items[idx];
		const replaced = mutateAt(child, segments, i + 1, mutate);
		if (replaced === null) return null;
		const newItems = current.items.slice();
		newItems[idx] = replaced;
		return {
			kind: "array",
			items: newItems,
			...current.line !== void 0 ? { line: current.line } : {}
		};
	}
	return null;
}
function rebuildMdRaw(ast) {
	const parts = [];
	if (ast.frontmatter.length > 0) {
		parts.push("---");
		for (const fm of ast.frontmatter) parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
		parts.push("---");
	}
	if (ast.preamble.length > 0) {
		if (parts.length > 0) parts.push("");
		parts.push(ast.preamble);
	}
	for (const block of ast.blocks) {
		if (parts.length > 0) parts.push("");
		parts.push(`## ${block.heading}`);
		if (block.bodyText.length > 0) parts.push(block.bodyText);
	}
	return {
		...ast,
		raw: parts.join("\n")
	};
}
function formatFrontmatterValue(value) {
	if (value.length === 0) return "\"\"";
	if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) return JSON.stringify(value);
	return value;
}
function slugifyHeading(s) {
	return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
//#endregion
//#region extensions/oc-path/src/oc-path/find.ts
/**
* `findOcPaths` — multi-match verb. `*` matches one sub-segment;
* `**` matches zero or more (recursive). Returns concrete OcPaths
* preserving the input pattern's slot shape, so each result is
* pipeable into `resolveOcPath` / `setOcPath`.
*
* @module @openclaw/oc-path/find
*/
function findOcPaths(ast, pattern) {
	const subs = patternSubs(pattern);
	if (!subs.some((s) => s.value === "*" || s.value === "**" || isPositionalSeg(s.value) || isUnionSeg(s.value) || isPredicateSeg(s.value))) {
		const m = resolveOcPath(ast, pattern);
		return m === null ? [] : [{
			path: pattern,
			match: m
		}];
	}
	const concretePaths = [];
	const onMatch = (slotSubs) => {
		concretePaths.push(repackSlotSubs(pattern, slotSubs));
	};
	switch (ast.kind) {
		case "jsonc":
			if (ast.root !== null) walkJsonc(ast.root, subs, 0, [], onMatch);
			break;
		case "jsonl":
			walkJsonl(ast, subs, 0, [], onMatch);
			break;
		case "md":
			walkMd({
				kind: "root",
				ast
			}, subs, 0, [], onMatch);
			break;
		case "yaml":
			if (ast.doc.contents !== null) walkYaml(ast.doc.contents, subs, 0, [], onMatch);
			break;
	}
	const out = [];
	for (const concrete of concretePaths) {
		const m = resolveOcPath(ast, concrete);
		if (m !== null) out.push({
			path: concrete,
			match: m
		});
	}
	return out;
}
function patternSubs(pattern) {
	const out = [];
	if (pattern.section !== void 0) for (const v of splitRespectingBrackets(pattern.section, ".")) out.push({
		slot: "section",
		value: v
	});
	if (pattern.item !== void 0) for (const v of splitRespectingBrackets(pattern.item, ".")) out.push({
		slot: "item",
		value: v
	});
	if (pattern.field !== void 0) for (const v of splitRespectingBrackets(pattern.field, ".")) out.push({
		slot: "field",
		value: v
	});
	return out;
}
function repackSlotSubs(pattern, slotSubs) {
	const sectionSubs = [];
	const itemSubs = [];
	const fieldSubs = [];
	for (const s of slotSubs) if (s.slot === "section") sectionSubs.push(s.value);
	else if (s.slot === "item") itemSubs.push(s.value);
	else fieldSubs.push(s.value);
	return {
		file: pattern.file,
		...sectionSubs.length > 0 ? { section: sectionSubs.join(".") } : {},
		...itemSubs.length > 0 ? { item: itemSubs.join(".") } : {},
		...fieldSubs.length > 0 ? { field: fieldSubs.join(".") } : {},
		...pattern.session !== void 0 ? { session: pattern.session } : {}
	};
}
function checkDepth(walked) {
	if (walked.length > 256) throw new OcPathError(`findOcPaths exceeded MAX_TRAVERSAL_DEPTH (256) — likely a pathological pattern`, "", "OC_PATH_DEPTH_EXCEEDED");
}
function dispatchSeg(node, ops, subs, i, walked, onMatch) {
	const cur = subs[i];
	if (isUnionSeg(cur.value)) {
		const alts = parseUnionSeg(cur.value);
		if (alts === null) return;
		for (const alt of alts) {
			const altSubs = subs.slice();
			altSubs[i] = {
				slot: cur.slot,
				value: alt
			};
			ops.walk(node, altSubs, i, walked, onMatch);
		}
		return;
	}
	if (isPredicateSeg(cur.value)) {
		const pred = parsePredicateSeg(cur.value);
		if (pred === null) return;
		for (const m of ops.predicate(node, pred)) ops.walk(m.child, subs, i + 1, [...walked, {
			slot: cur.slot,
			value: m.keySub
		}], onMatch);
		return;
	}
	if (cur.value === "**") {
		if (i + 1 >= subs.length) onMatch(walked);
		for (const m of ops.enumerate(node)) {
			const nextWalked = [...walked, {
				slot: cur.slot,
				value: m.keySub
			}];
			ops.walk(m.child, subs, i + 1, nextWalked, onMatch);
			ops.walk(m.child, subs, i, nextWalked, onMatch);
		}
		return;
	}
	if (cur.value === "*") {
		for (const m of ops.enumerate(node)) ops.walk(m.child, subs, i + 1, [...walked, {
			slot: cur.slot,
			value: m.keySub
		}], onMatch);
		return;
	}
	if (isPositionalSeg(cur.value)) {
		const m = ops.positional(node, cur.value);
		if (m === null) return;
		ops.walk(m.child, subs, i + 1, [...walked, {
			slot: cur.slot,
			value: m.keySub
		}], onMatch);
		return;
	}
	const m = ops.lookup(node, cur.value);
	if (m === null) return;
	ops.walk(m.child, subs, i + 1, [...walked, {
		slot: cur.slot,
		value: m.keySub
	}], onMatch);
}
function walkJsonc(node, subs, i, walked, onMatch) {
	checkDepth(walked);
	if (i >= subs.length) {
		onMatch(walked);
		return;
	}
	dispatchSeg(node, jsoncOps, subs, i, walked, onMatch);
}
const jsoncOps = {
	*enumerate(node) {
		if (node.kind === "object") for (const e of node.entries) yield {
			keySub: quoteSeg(e.key),
			child: e.value
		};
		else if (node.kind === "array") for (let idx = 0; idx < node.items.length; idx++) yield {
			keySub: String(idx),
			child: node.items[idx]
		};
	},
	lookup(node, key) {
		if (node.kind === "object") {
			const lookupKey = isQuotedSeg(key) ? unquoteSeg(key) : key;
			const e = node.entries.find((entry) => entry.key === lookupKey);
			return e === void 0 ? null : {
				keySub: key,
				child: e.value
			};
		}
		if (node.kind === "array") {
			const idx = Number(key);
			if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) return null;
			return {
				keySub: key,
				child: node.items[idx]
			};
		}
		return null;
	},
	positional(node, seg) {
		const concrete = positionalForJsoncNode(node, seg);
		if (concrete === null) return null;
		return jsoncOps.lookup(node, concrete);
	},
	*predicate(node, pred) {
		if (node.kind === "object") {
			for (const e of node.entries) if (jsoncChildMatchesPredicate(e.value, pred)) yield {
				keySub: quoteSeg(e.key),
				child: e.value
			};
		} else if (node.kind === "array") {
			for (let idx = 0; idx < node.items.length; idx++) if (jsoncChildMatchesPredicate(node.items[idx], pred)) yield {
				keySub: String(idx),
				child: node.items[idx]
			};
		}
	},
	walk: walkJsonc
};
function positionalForJsoncNode(node, seg) {
	if (node.kind === "object") {
		const keys = node.entries.map((e) => e.key);
		return resolvePositionalSeg(seg, {
			indexable: false,
			size: keys.length,
			keys
		});
	}
	if (node.kind === "array") return resolvePositionalSeg(seg, {
		indexable: true,
		size: node.items.length
	});
	return null;
}
function walkJsonl(ast, subs, i, walked, onMatch) {
	checkDepth(walked);
	if (i >= subs.length) {
		onMatch(walked);
		return;
	}
	if (walked.length === 0) dispatchSeg(ast, jsonlOps, subs, i, walked, onMatch);
}
const jsonlOps = {
	*enumerate(ast) {
		for (const l of ast.lines) if (l.kind === "value") yield {
			keySub: `L${l.line}`,
			child: lineHolder(ast, l)
		};
	},
	lookup(ast, key) {
		const line = pickLine(ast, key);
		if (line === null) return null;
		return {
			keySub: line.kind === "value" ? `L${line.line}` : key,
			child: lineHolder(ast, line)
		};
	},
	positional(ast, seg) {
		return jsonlOps.lookup(ast, seg);
	},
	*predicate(ast, pred) {
		for (const l of ast.lines) {
			if (l.kind !== "value") continue;
			if (evaluatePredicate(topLevelLeafText(l.value, pred.key), pred)) yield {
				keySub: `L${l.line}`,
				child: lineHolder(ast, l)
			};
		}
	},
	walk(child, subs, i, walked, onMatch) {
		const line = unwrapHolder(child);
		if (line === null) {
			walkJsonl(child, subs, i, walked, onMatch);
			return;
		}
		if (i >= subs.length) {
			onMatch(walked);
			return;
		}
		if (line.kind !== "value") return;
		walkJsonc(line.value, subs, i, walked, onMatch);
	}
};
const lineByHolder = /* @__PURE__ */ new WeakMap();
function lineHolder(ast, line) {
	const holder = {
		kind: "jsonl",
		raw: ast.raw,
		lines: ast.lines
	};
	lineByHolder.set(holder, line);
	return holder;
}
function unwrapHolder(holder) {
	return lineByHolder.get(holder) ?? null;
}
function topLevelLeafText(value, key) {
	if (value.kind !== "object") return null;
	const entry = value.entries.find((e) => e.key === key);
	if (entry === void 0) return null;
	const v = entry.value;
	if (v.kind === "string") return v.value;
	if (v.kind === "number" || v.kind === "boolean") return String(v.value);
	return null;
}
function pickLine(ast, addr) {
	if (addr === "$first") {
		for (const l of ast.lines) if (l.kind === "value") return l;
		return null;
	}
	if (addr === "$last") {
		for (let i = ast.lines.length - 1; i >= 0; i--) {
			const l = ast.lines[i];
			if (l !== void 0 && l.kind === "value") return l;
		}
		return null;
	}
	const m = /^L(\d+)$/.exec(addr);
	if (m === null || m[1] === void 0) return null;
	const target = Number(m[1]);
	for (const l of ast.lines) if (l.line === target) return l;
	return null;
}
function walkYaml(node, subs, i, walked, onMatch) {
	checkDepth(walked);
	if (i >= subs.length) {
		onMatch(walked);
		return;
	}
	dispatchSeg(node, yamlOps, subs, i, walked, onMatch);
}
const yamlOps = {
	*enumerate(node) {
		if (isMap(node)) for (const p of node.items) {
			const k = isScalar(p.key) ? p.key.value : p.key;
			if (p.value !== null) yield {
				keySub: quoteSeg(String(k)),
				child: p.value
			};
		}
		else if (isSeq(node)) for (let idx = 0; idx < node.items.length; idx++) {
			const child = node.items[idx];
			if (child !== null) yield {
				keySub: String(idx),
				child
			};
		}
	},
	lookup(node, key) {
		if (isMap(node)) {
			const lookupKey = isQuotedSeg(key) ? unquoteSeg(key) : key;
			const pair = node.items.find((p) => {
				const k = isScalar(p.key) ? p.key.value : p.key;
				return String(k) === lookupKey;
			});
			return pair?.value === void 0 || pair.value === null ? null : {
				keySub: key,
				child: pair.value
			};
		}
		if (isSeq(node)) {
			const idx = Number(key);
			const child = node.items[idx];
			if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length || child === null) return null;
			return {
				keySub: key,
				child
			};
		}
		return null;
	},
	positional(node, seg) {
		const concrete = positionalForYamlNode(node, seg);
		return concrete === null ? null : yamlOps.lookup(node, concrete);
	},
	*predicate(node, pred) {
		if (isMap(node)) for (const p of node.items) {
			const k = isScalar(p.key) ? p.key.value : p.key;
			if (p.value !== null && yamlChildMatchesPredicate(p.value, pred)) yield {
				keySub: quoteSeg(String(k)),
				child: p.value
			};
		}
		else if (isSeq(node)) for (let idx = 0; idx < node.items.length; idx++) {
			const child = node.items[idx];
			if (child !== null && yamlChildMatchesPredicate(child, pred)) yield {
				keySub: String(idx),
				child
			};
		}
	},
	walk: walkYaml
};
function positionalForYamlNode(node, seg) {
	if (isMap(node)) {
		const keys = node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
		return resolvePositionalSeg(seg, {
			indexable: false,
			size: keys.length,
			keys
		});
	}
	if (isSeq(node)) return resolvePositionalSeg(seg, {
		indexable: true,
		size: node.items.length
	});
	return null;
}
function yamlChildMatchesPredicate(node, pred) {
	return evaluatePredicate(yamlChildFieldText(node, pred.key), pred);
}
function yamlChildFieldText(node, key) {
	if (!isMap(node)) return null;
	const pair = node.items.find((p) => {
		const k = isScalar(p.key) ? p.key.value : p.key;
		return String(k) === key;
	});
	if (pair === void 0 || pair.value === null) return null;
	return yamlScalarToText(pair.value);
}
function yamlScalarToText(value) {
	if (!isScalar(value)) return null;
	const scalar = value.value;
	if (typeof scalar === "string") return scalar;
	if (typeof scalar === "number" || typeof scalar === "boolean") return String(scalar);
	if (scalar === null) return "null";
	if (typeof scalar === "bigint" || typeof scalar === "symbol") return scalar.toString();
	if (scalar instanceof Date) return scalar.toISOString();
	return JSON.stringify(scalar) ?? null;
}
function walkMd(level, subs, i, walked, onMatch) {
	if (i >= subs.length) {
		onMatch(walked);
		return;
	}
	const cur = subs[i];
	if (level.kind === "root" && walked.length === 0 && cur.value === "[frontmatter]") {
		const next = subs[i + 1];
		if (next === void 0) {
			onMatch([{
				slot: cur.slot,
				value: cur.value
			}]);
			return;
		}
		if (next.value === "*" || next.value === "**") {
			for (const fm of level.ast.frontmatter) onMatch([{
				slot: cur.slot,
				value: cur.value
			}, {
				slot: next.slot,
				value: fm.key
			}]);
			return;
		}
		const fmKey = isQuotedSeg(next.value) ? unquoteSeg(next.value) : next.value;
		if (level.ast.frontmatter.find((e) => e.key === fmKey) === void 0) return;
		onMatch([{
			slot: cur.slot,
			value: cur.value
		}, {
			slot: next.slot,
			value: next.value
		}]);
		return;
	}
	if (level.kind === "item") {
		walkMdItemField(level.item, cur, walked, onMatch);
		return;
	}
	dispatchSeg(level, mdOps, subs, i, walked, onMatch);
}
function walkMdItemField(item, cur, walked, onMatch) {
	if (item.kv === void 0) return;
	const key = item.kv.key;
	const emit = (value) => {
		onMatch([...walked, {
			slot: cur.slot,
			value
		}]);
	};
	if (isUnionSeg(cur.value)) {
		const alts = parseUnionSeg(cur.value);
		if (alts === null) return;
		for (const alt of alts) if (alt.toLowerCase() === key.toLowerCase()) emit(key);
		return;
	}
	if (isPredicateSeg(cur.value)) {
		const pred = parsePredicateSeg(cur.value);
		if (pred !== null && mdItemMatchesPredicate(item, pred)) emit(key);
		return;
	}
	if (cur.value === "*" || cur.value === "**") {
		emit(key);
		return;
	}
	if (key.toLowerCase() === cur.value.toLowerCase()) emit(cur.value);
}
function blockSlugCounts(items) {
	const counts = /* @__PURE__ */ new Map();
	for (const item of items) counts.set(item.slug, (counts.get(item.slug) ?? 0) + 1);
	return counts;
}
const mdOps = {
	*enumerate(level) {
		if (level.kind === "root") {
			for (const block of level.ast.blocks) yield {
				keySub: block.slug,
				child: {
					kind: "block",
					block,
					ast: level.ast
				}
			};
			return;
		}
		if (level.kind === "block") {
			const counts = blockSlugCounts(level.block.items);
			for (let idx = 0; idx < level.block.items.length; idx++) {
				const item = level.block.items[idx];
				yield {
					keySub: (counts.get(item.slug) ?? 0) > 1 ? `#${idx}` : item.slug,
					child: {
						kind: "item",
						item,
						ast: level.ast
					}
				};
			}
		}
	},
	lookup(level, key) {
		if (level.kind === "root") {
			const target = key.toLowerCase();
			const block = level.ast.blocks.find((b) => b.slug === target);
			return block === void 0 ? null : {
				keySub: key,
				child: {
					kind: "block",
					block,
					ast: level.ast
				}
			};
		}
		if (level.kind === "block") {
			if (isOrdinalSeg(key)) {
				const n = parseOrdinalSeg(key);
				if (n === null || n < 0 || n >= level.block.items.length) return null;
				return {
					keySub: key,
					child: {
						kind: "item",
						item: level.block.items[n],
						ast: level.ast
					}
				};
			}
			const target = key.toLowerCase();
			const item = level.block.items.find((it) => it.slug === target);
			return item === void 0 ? null : {
				keySub: key,
				child: {
					kind: "item",
					item,
					ast: level.ast
				}
			};
		}
		return null;
	},
	positional(level, seg) {
		if (level.kind !== "block") return null;
		const concrete = resolvePositionalSeg(seg, {
			indexable: true,
			size: level.block.items.length
		});
		if (concrete === null) return null;
		return {
			keySub: seg,
			child: {
				kind: "item",
				item: level.block.items[Number(concrete)],
				ast: level.ast
			}
		};
	},
	*predicate(level, pred) {
		if (level.kind === "root") {
			for (const block of level.ast.blocks) if (mdBlockHasMatchingItem(block, pred)) yield {
				keySub: block.slug,
				child: {
					kind: "block",
					block,
					ast: level.ast
				}
			};
			return;
		}
		if (level.kind === "block") {
			const counts = blockSlugCounts(level.block.items);
			for (let idx = 0; idx < level.block.items.length; idx++) {
				const item = level.block.items[idx];
				if (mdItemMatchesPredicate(item, pred)) yield {
					keySub: (counts.get(item.slug) ?? 0) > 1 ? `#${idx}` : item.slug,
					child: {
						kind: "item",
						item,
						ast: level.ast
					}
				};
			}
		}
	},
	walk: walkMd
};
function mdItemMatchesPredicate(item, pred) {
	if (item.kv === void 0) return false;
	if (item.kv.key.toLowerCase() !== pred.key.toLowerCase()) return false;
	return evaluatePredicate(item.kv.value, pred);
}
function mdBlockHasMatchingItem(block, pred) {
	for (const item of block.items) if (mdItemMatchesPredicate(item, pred)) return true;
	return false;
}
function jsoncChildMatchesPredicate(node, pred) {
	return evaluatePredicate(jsoncChildFieldText(node, pred.key), pred);
}
function jsoncChildFieldText(node, key) {
	if (node.kind !== "object") return null;
	const e = node.entries.find((entry) => entry.key === key);
	if (e === void 0) return null;
	const v = e.value;
	if (v.kind === "string") return v.value;
	if (v.kind === "number" || v.kind === "boolean") return String(v.value);
	if (v.kind === "null") return "null";
	return null;
}
//#endregion
//#region extensions/oc-path/src/oc-path/dispatch.ts
/**
* Recommend a kind from a filename. Pure convention helper — returns
* the substrate's default mapping. Consumers can override.
*/
function inferKind(filename) {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".md")) return "md";
	if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
	if (lower.endsWith(".jsonc") || lower.endsWith(".json")) return "jsonc";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".lobster")) return "yaml";
	return null;
}
//#endregion
//#region extensions/oc-path/src/cli.ts
/**
* `openclaw path` — shell access to the OcPath substrate verbs.
*
* Subcommands: `resolve` / `set` / `find` / `validate` / `emit`.
* TTY-aware output: human when interactive, JSON when piped; `--json`
* / `--human` override.
*/
const SCRUB_PLACEHOLDER = "[REDACTED]";
const defaultRuntime = {
	writeStdout(value) {
		process.stdout.write(value);
	},
	error(value) {
		process.stderr.write(`${value}\n`);
	},
	exit(code) {
		process.exitCode = code;
	}
};
function scrubSentinel(s) {
	if (!s.includes("__OPENCLAW_REDACTED__")) return s;
	return s.split(REDACTED_SENTINEL).join(SCRUB_PLACEHOLDER);
}
function detectMode(options) {
	if (options.json === true) return "json";
	if (options.human === true) return "human";
	return process.stdout.isTTY ? "human" : "json";
}
function emit(runtime, mode, value, humanFallback) {
	if (mode === "json") {
		runtime.writeStdout(scrubSentinel(JSON.stringify(value, null, 2)));
		return;
	}
	runtime.writeStdout(scrubSentinel(humanFallback()));
}
function emitError(runtime, mode, message, code = "ERR") {
	const scrubbed = scrubSentinel(message);
	if (mode === "json") {
		runtime.error(JSON.stringify({ error: {
			code,
			message: scrubbed
		} }));
		return;
	}
	runtime.error(`${code}: ${scrubbed}`);
}
/** Bail with usage error if a required arg is missing. */
function requireArg(value, usage, runtime, mode) {
	if (value === void 0) {
		emitError(runtime, mode, usage);
		runtime.exit(2);
		return false;
	}
	return true;
}
/** Parse an oc-path string; emit structured error and return null on failure. */
function tryParse(pathStr, runtime, mode) {
	try {
		return parseOcPath(pathStr);
	} catch (err) {
		if (err instanceof OcPathError) {
			emitError(runtime, mode, `parse failed: ${err.message}`, err.code);
			runtime.exit(2);
			return null;
		}
		throw err;
	}
}
function catchSentinel(label, runtime, mode, fn) {
	try {
		return fn();
	} catch (err) {
		if (err instanceof OcEmitSentinelError) {
			emitError(runtime, mode, `${label} refused: ${err.message}`, "OC_EMIT_SENTINEL");
			runtime.exit(1);
			return null;
		}
		throw err;
	}
}
async function loadAst(absPath, fileName) {
	const raw = await promises.readFile(absPath, "utf-8");
	const kind = inferKind(fileName);
	if (kind === "jsonc") return parseJsonc(raw).ast;
	if (kind === "jsonl") return parseJsonl(raw).ast;
	if (kind === "yaml") return parseYaml(raw).ast;
	return parseMd(raw).ast;
}
function emitForKind(ast, fileName) {
	const opts = fileName !== void 0 ? { fileNameForGuard: fileName } : {};
	switch (ast.kind) {
		case "jsonc": return emitJsonc(ast, opts);
		case "jsonl": return emitJsonl(ast, opts);
		case "md": return emitMd(ast, opts);
		case "yaml": return emitYaml(ast, opts);
	}
	return "";
}
function resolveFsPath(path, options) {
	if (options.file !== void 0) return resolve(options.file);
	return resolve(options.cwd ?? process.cwd(), path.file);
}
function formatMatchHuman(match) {
	if (match.kind === "leaf") return `leaf @ L${match.line}: ${JSON.stringify(match.valueText)} (${match.leafType})`;
	if (match.kind === "node") return `node @ L${match.line} [${match.descriptor}]`;
	if (match.kind === "insertion-point") return `insertion-point @ L${match.line} [${match.container}]`;
	return `root @ L${match.line}`;
}
function splitDiffLines(s) {
	return s === "" ? [] : s.split("\n");
}
function formatUnifiedDiff(oldBytes, newBytes, fsPath) {
	if (oldBytes === newBytes) return "";
	const oldLines = splitDiffLines(oldBytes);
	const newLines = splitDiffLines(newBytes);
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let oldSuffix = oldLines.length - 1;
	let newSuffix = newLines.length - 1;
	while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
		oldSuffix--;
		newSuffix--;
	}
	const context = 3;
	const hunkStart = Math.max(0, prefix - context);
	const hunkOldEnd = Math.min(oldLines.length - 1, oldSuffix + context);
	const hunkNewEnd = Math.min(newLines.length - 1, newSuffix + context);
	const oldCount = Math.max(0, hunkOldEnd - hunkStart + 1);
	const newCount = Math.max(0, hunkNewEnd - hunkStart + 1);
	const lines = [
		`--- ${fsPath}`,
		`+++ ${fsPath}`,
		`@@ -${hunkStart + 1},${oldCount} +${hunkStart + 1},${newCount} @@`
	];
	for (let i = hunkStart; i < prefix; i++) lines.push(` ${oldLines[i] ?? ""}`);
	for (let i = prefix; i <= oldSuffix; i++) lines.push(`-${oldLines[i] ?? ""}`);
	for (let i = prefix; i <= newSuffix; i++) lines.push(`+${newLines[i] ?? ""}`);
	for (let i = Math.max(oldSuffix + 1, prefix); i <= hunkOldEnd; i++) lines.push(` ${oldLines[i] ?? ""}`);
	return `${lines.join("\n")}\n`;
}
async function pathResolveCommand(pathStr, options, runtime) {
	const mode = detectMode(options);
	if (!requireArg(pathStr, "resolve: missing <oc-path> argument", runtime, mode)) return;
	const ocPath = tryParse(pathStr, runtime, mode);
	if (ocPath === null) return;
	const ast = await loadAst(resolveFsPath(ocPath, options), ocPath.file);
	let match;
	try {
		match = resolveOcPath(ast, ocPath);
	} catch (err) {
		if (err instanceof OcPathError) {
			emitError(runtime, mode, `resolve refused: ${err.message}`, err.code);
			runtime.exit(2);
			return;
		}
		throw err;
	}
	if (match === null) {
		emit(runtime, mode, {
			resolved: false,
			ocPath: pathStr
		}, () => `not found: ${pathStr}`);
		runtime.exit(1);
		return;
	}
	emit(runtime, mode, {
		resolved: true,
		ocPath: pathStr,
		match
	}, () => formatMatchHuman(match));
}
async function pathSetCommand(pathStr, value, options, runtime) {
	const mode = detectMode(options);
	if (!requireArg(pathStr, "set: requires <oc-path> <value>", runtime, mode)) return;
	if (!requireArg(value, "set: requires <oc-path> <value>", runtime, mode)) return;
	if (options.diff === true && options.dryRun !== true) {
		emit(runtime, mode, {
			ok: false,
			reason: "--diff requires --dry-run"
		}, () => "set failed: --diff requires --dry-run");
		runtime.exit(1);
		return;
	}
	const ocPath = tryParse(pathStr, runtime, mode);
	if (ocPath === null) return;
	const fsPath = resolveFsPath(ocPath, options);
	const oldBytes = await promises.readFile(fsPath, "utf-8");
	const ast = await loadAst(fsPath, ocPath.file);
	const result = catchSentinel("set", runtime, mode, () => setOcPath(ast, ocPath, value));
	if (result === null) return;
	if (!result.ok) {
		const detail = "detail" in result ? result.detail : void 0;
		emit(runtime, mode, {
			ok: false,
			reason: result.reason,
			detail
		}, () => `set failed: ${result.reason}${detail !== void 0 ? ` — ${detail}` : ""}`);
		runtime.exit(1);
		return;
	}
	const newBytes = catchSentinel("emit", runtime, mode, () => emitForKind(result.ast, ocPath.file));
	if (newBytes === null) return;
	if (options.dryRun === true) {
		const diff = options.diff === true ? formatUnifiedDiff(oldBytes, newBytes, fsPath) : void 0;
		emit(runtime, mode, {
			ok: true,
			dryRun: true,
			bytes: newBytes,
			...diff !== void 0 ? { diff } : {}
		}, () => diff !== void 0 ? diff || `--dry-run: no byte changes for ${fsPath}` : `--dry-run: would write ${newBytes.length} bytes to ${fsPath}\n${newBytes}`);
		return;
	}
	await promises.writeFile(fsPath, newBytes, "utf-8");
	emit(runtime, mode, {
		ok: true,
		dryRun: false,
		bytesWritten: newBytes.length,
		fsPath
	}, () => `wrote ${newBytes.length} bytes to ${fsPath}`);
}
async function pathFindCommand(patternStr, options, runtime) {
	const mode = detectMode(options);
	if (!requireArg(patternStr, "find: missing <pattern> argument", runtime, mode)) return;
	const pattern = tryParse(patternStr, runtime, mode);
	if (pattern === null) return;
	if (/[*?]/.test(pattern.file)) {
		emitError(runtime, mode, `find: file-slot wildcards are not supported (got "${pattern.file}"). Pass a concrete file path; multi-file globbing is a follow-up feature.`, "OC_PATH_FILE_WILDCARD_UNSUPPORTED");
		runtime.exit(2);
		return;
	}
	const matches = findOcPaths(await loadAst(resolveFsPath(pattern, options), pattern.file), pattern);
	emit(runtime, mode, {
		pattern: patternStr,
		count: matches.length,
		matches: matches.map((m) => ({
			path: formatOcPath(m.path),
			match: m.match
		}))
	}, () => {
		if (matches.length === 0) return `0 matches for ${patternStr}`;
		const plural = matches.length === 1 ? "" : "es";
		const lines = [`${matches.length} match${plural} for ${patternStr}:`];
		for (const m of matches) lines.push(`  ${formatOcPath(m.path)}  →  ${formatMatchHuman(m.match)}`);
		return lines.join("\n");
	});
	if (matches.length === 0) runtime.exit(1);
}
function pathValidateCommand(pathStr, options, runtime) {
	const mode = detectMode(options);
	if (!requireArg(pathStr, "validate: missing <oc-path> argument", runtime, mode)) return;
	try {
		const ocPath = parseOcPath(pathStr);
		emit(runtime, mode, {
			valid: true,
			ocPath: pathStr,
			formatted: formatOcPath(ocPath),
			structure: {
				file: ocPath.file,
				section: ocPath.section,
				item: ocPath.item,
				field: ocPath.field,
				session: ocPath.session
			}
		}, () => {
			const lines = [`valid: ${pathStr}`, `  file:    ${ocPath.file}`];
			if (ocPath.section !== void 0) lines.push(`  section: ${ocPath.section}`);
			if (ocPath.item !== void 0) lines.push(`  item:    ${ocPath.item}`);
			if (ocPath.field !== void 0) lines.push(`  field:   ${ocPath.field}`);
			if (ocPath.session !== void 0) lines.push(`  session: ${ocPath.session}`);
			return lines.join("\n");
		});
	} catch (err) {
		if (err instanceof OcPathError) {
			emit(runtime, mode, {
				valid: false,
				code: err.code,
				message: err.message
			}, () => `INVALID: ${err.code}: ${err.message}`);
			runtime.exit(1);
			return;
		}
		throw err;
	}
}
async function pathEmitCommand(fileArg, options, runtime) {
	const mode = detectMode(options);
	if (!requireArg(fileArg, "emit: missing <file> argument", runtime, mode)) return;
	const fsPath = options.file !== void 0 ? resolve(options.file) : resolve(options.cwd ?? process.cwd(), fileArg);
	const fileName = fsPath.split(/[\\/]/).pop() ?? fileArg;
	const ast = await loadAst(fsPath, fileName);
	const bytes = catchSentinel("emit", runtime, mode, () => emitForKind(ast, fileName));
	if (bytes === null) return;
	if (mode === "json") {
		runtime.writeStdout(scrubSentinel(JSON.stringify({
			ok: true,
			kind: ast.kind,
			bytes
		})));
		return;
	}
	runtime.writeStdout(bytes);
}
function withCommonOpts(cmd) {
	return cmd.option("--json", "Force JSON output").option("--human", "Force human output").option("--cwd <dir>", "Resolve file slot against this directory").option("--file <file>", "Override the file slot's resolved path");
}
function registerPathCli(program) {
	const path = program.command("path").description("Inspect and edit workspace files via the oc:// addressing scheme").addHelpText("after", "\nDocs: https://docs.openclaw.ai/cli/path\n");
	withCommonOpts(path.command("resolve").description("Print the match at an oc:// path").argument("<oc-path>", "oc:// path to resolve")).action(async (pathStr, opts) => {
		await pathResolveCommand(pathStr, opts, defaultRuntime);
	});
	withCommonOpts(path.command("find").description("Enumerate matches for a wildcard / predicate oc:// pattern").argument("<pattern>", "oc:// pattern")).action(async (patternStr, opts) => {
		await pathFindCommand(patternStr, opts, defaultRuntime);
	});
	withCommonOpts(path.command("set").description("Write a leaf value at an oc:// path").argument("<oc-path>", "oc:// path to write").argument("<value>", "string value to write").option("--dry-run", "Print bytes without writing").option("--diff", "With --dry-run, print a unified diff instead of full bytes")).action(async (pathStr, value, opts) => {
		await pathSetCommand(pathStr, value, opts, defaultRuntime);
	});
	path.command("validate").description("Parse an oc:// path and print its slot structure").argument("<oc-path>", "oc:// path to validate").option("--json", "Force JSON output").option("--human", "Force human output").action((pathStr, opts) => {
		pathValidateCommand(pathStr, opts, defaultRuntime);
	});
	withCommonOpts(path.command("emit").description("Round-trip a file through parse + emit").argument("<file>", "Path to a workspace file")).action(async (fileArg, opts) => {
		await pathEmitCommand(fileArg, opts, defaultRuntime);
	});
	path.action(() => {
		path.outputHelp();
		process.exitCode = 0;
	});
}
//#endregion
export { registerPathCli };
