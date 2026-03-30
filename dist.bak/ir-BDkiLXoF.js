import { Ct as shouldLogVerbose, bt as logVerbose, st as resolveUserPath } from "./entry.js";
import { _ as maxBytesForKind, a as hasAlphaChannel, c as detectMime, l as extensionForMime, o as optimizeImageToPng, r as convertHeicToJpeg, s as resizeToJpeg, v as mediaKindFromMime } from "./image-ops-Z3_QkQPj.js";
import { r as readLocalFileSafely, t as SafeOpenError } from "./fs-safe-BDinrAxW.js";
import { a as chunkText } from "./chunk-BzS5RYkf.js";
import { i as fetchRemoteMedia, n as getDefaultMediaLocalRoots } from "./local-roots-DGlEdY2D.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import MarkdownIt from "markdown-it";

//#region src/web/media.ts
function resolveWebMediaOptions(params) {
	if (typeof params.maxBytesOrOptions === "number" || params.maxBytesOrOptions === void 0) return {
		maxBytes: params.maxBytesOrOptions,
		optimizeImages: params.optimizeImages,
		ssrfPolicy: params.options?.ssrfPolicy,
		localRoots: params.options?.localRoots
	};
	return {
		...params.maxBytesOrOptions,
		optimizeImages: params.optimizeImages ? params.maxBytesOrOptions.optimizeImages ?? true : false
	};
}
var LocalMediaAccessError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "LocalMediaAccessError";
	}
};
function getDefaultLocalRoots() {
	return getDefaultMediaLocalRoots();
}
async function assertLocalMediaAllowed(mediaPath, localRoots) {
	if (localRoots === "any") return;
	const roots = localRoots ?? getDefaultLocalRoots();
	let resolved;
	try {
		resolved = await fs.realpath(mediaPath);
	} catch {
		resolved = path.resolve(mediaPath);
	}
	if (localRoots === void 0) {
		const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
		if (workspaceRoot) {
			const stateDir = path.dirname(workspaceRoot);
			const rel = path.relative(stateDir, resolved);
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
				if ((rel.split(path.sep)[0] ?? "").startsWith("workspace-")) throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
			}
		}
	}
	for (const root of roots) {
		let resolvedRoot;
		try {
			resolvedRoot = await fs.realpath(root);
		} catch {
			resolvedRoot = path.resolve(root);
		}
		if (resolvedRoot === path.parse(resolvedRoot).root) throw new LocalMediaAccessError("invalid-root", `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`);
		if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) return;
	}
	throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
}
const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const MB = 1024 * 1024;
function formatMb(bytes, digits = 2) {
	return (bytes / MB).toFixed(digits);
}
function formatCapLimit(label, cap, size) {
	return `${label} exceeds ${formatMb(cap, 0)}MB limit (got ${formatMb(size)}MB)`;
}
function formatCapReduce(label, cap, size) {
	return `${label} could not be reduced below ${formatMb(cap, 0)}MB (got ${formatMb(size)}MB)`;
}
function isHeicSource(opts) {
	if (opts.contentType && HEIC_MIME_RE.test(opts.contentType.trim())) return true;
	if (opts.fileName && HEIC_EXT_RE.test(opts.fileName.trim())) return true;
	return false;
}
function toJpegFileName(fileName) {
	if (!fileName) return;
	const trimmed = fileName.trim();
	if (!trimmed) return fileName;
	const parsed = path.parse(trimmed);
	if (!parsed.ext || HEIC_EXT_RE.test(parsed.ext)) return path.format({
		dir: parsed.dir,
		name: parsed.name || trimmed,
		ext: ".jpg"
	});
	return path.format({
		dir: parsed.dir,
		name: parsed.name,
		ext: ".jpg"
	});
}
function logOptimizedImage(params) {
	if (!shouldLogVerbose()) return;
	if (params.optimized.optimizedSize >= params.originalSize) return;
	if (params.optimized.format === "png") {
		logVerbose(`Optimized PNG (preserving alpha) from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side≤${params.optimized.resizeSide}px)`);
		return;
	}
	logVerbose(`Optimized media from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side≤${params.optimized.resizeSide}px, q=${params.optimized.quality})`);
}
async function optimizeImageWithFallback(params) {
	const { buffer, cap, meta } = params;
	if ((meta?.contentType === "image/png" || meta?.fileName?.toLowerCase().endsWith(".png")) && await hasAlphaChannel(buffer)) {
		const optimized = await optimizeImageToPng(buffer, cap);
		if (optimized.buffer.length <= cap) return {
			...optimized,
			format: "png"
		};
		if (shouldLogVerbose()) logVerbose(`PNG with alpha still exceeds ${formatMb(cap, 0)}MB after optimization; falling back to JPEG`);
	}
	return {
		...await optimizeImageToJpeg(buffer, cap, meta),
		format: "jpeg"
	};
}
async function loadWebMediaInternal(mediaUrl, options = {}) {
	const { maxBytes, optimizeImages = true, ssrfPolicy, localRoots, sandboxValidated = false, readFile: readFileOverride } = options;
	mediaUrl = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
	if (mediaUrl.startsWith("file://")) try {
		mediaUrl = fileURLToPath(mediaUrl);
	} catch {
		throw new LocalMediaAccessError("invalid-file-url", `Invalid file:// URL: ${mediaUrl}`);
	}
	const optimizeAndClampImage = async (buffer, cap, meta) => {
		const originalSize = buffer.length;
		const optimized = await optimizeImageWithFallback({
			buffer,
			cap,
			meta
		});
		logOptimizedImage({
			originalSize,
			optimized
		});
		if (optimized.buffer.length > cap) throw new Error(formatCapReduce("Media", cap, optimized.buffer.length));
		const contentType = optimized.format === "png" ? "image/png" : "image/jpeg";
		const fileName = optimized.format === "jpeg" && meta && isHeicSource(meta) ? toJpegFileName(meta.fileName) : meta?.fileName;
		return {
			buffer: optimized.buffer,
			contentType,
			kind: "image",
			fileName
		};
	};
	const clampAndFinalize = async (params) => {
		const cap = maxBytes !== void 0 ? maxBytes : maxBytesForKind(params.kind);
		if (params.kind === "image") {
			const isGif = params.contentType === "image/gif";
			if (isGif || !optimizeImages) {
				if (params.buffer.length > cap) throw new Error(formatCapLimit(isGif ? "GIF" : "Media", cap, params.buffer.length));
				return {
					buffer: params.buffer,
					contentType: params.contentType,
					kind: params.kind,
					fileName: params.fileName
				};
			}
			return { ...await optimizeAndClampImage(params.buffer, cap, {
				contentType: params.contentType,
				fileName: params.fileName
			}) };
		}
		if (params.buffer.length > cap) throw new Error(formatCapLimit("Media", cap, params.buffer.length));
		return {
			buffer: params.buffer,
			contentType: params.contentType ?? void 0,
			kind: params.kind,
			fileName: params.fileName
		};
	};
	if (/^https?:\/\//i.test(mediaUrl)) {
		const defaultFetchCap = maxBytesForKind("unknown");
		const { buffer, contentType, fileName } = await fetchRemoteMedia({
			url: mediaUrl,
			maxBytes: maxBytes === void 0 ? defaultFetchCap : optimizeImages ? Math.max(maxBytes, defaultFetchCap) : maxBytes,
			ssrfPolicy
		});
		return await clampAndFinalize({
			buffer,
			contentType,
			kind: mediaKindFromMime(contentType),
			fileName
		});
	}
	if (mediaUrl.startsWith("~")) mediaUrl = resolveUserPath(mediaUrl);
	if ((sandboxValidated || localRoots === "any") && !readFileOverride) throw new LocalMediaAccessError("unsafe-bypass", "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.");
	if (!(sandboxValidated || localRoots === "any")) await assertLocalMediaAllowed(mediaUrl, localRoots);
	let data;
	if (readFileOverride) data = await readFileOverride(mediaUrl);
	else try {
		data = (await readLocalFileSafely({ filePath: mediaUrl })).buffer;
	} catch (err) {
		if (err instanceof SafeOpenError) {
			if (err.code === "not-found") throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, { cause: err });
			if (err.code === "not-file") throw new LocalMediaAccessError("not-file", `Local media path is not a file: ${mediaUrl}`, { cause: err });
			throw new LocalMediaAccessError("invalid-path", `Local media path is not safe to read: ${mediaUrl}`, { cause: err });
		}
		throw err;
	}
	const mime = await detectMime({
		buffer: data,
		filePath: mediaUrl
	});
	const kind = mediaKindFromMime(mime);
	let fileName = path.basename(mediaUrl) || void 0;
	if (fileName && !path.extname(fileName) && mime) {
		const ext = extensionForMime(mime);
		if (ext) fileName = `${fileName}${ext}`;
	}
	return await clampAndFinalize({
		buffer: data,
		contentType: mime,
		kind,
		fileName
	});
}
async function loadWebMedia(mediaUrl, maxBytesOrOptions, options) {
	return await loadWebMediaInternal(mediaUrl, resolveWebMediaOptions({
		maxBytesOrOptions,
		options,
		optimizeImages: true
	}));
}
async function loadWebMediaRaw(mediaUrl, maxBytesOrOptions, options) {
	return await loadWebMediaInternal(mediaUrl, resolveWebMediaOptions({
		maxBytesOrOptions,
		options,
		optimizeImages: false
	}));
}
async function optimizeImageToJpeg(buffer, maxBytes, opts = {}) {
	let source = buffer;
	if (isHeicSource(opts)) try {
		source = await convertHeicToJpeg(buffer);
	} catch (err) {
		throw new Error(`HEIC image conversion failed: ${String(err)}`, { cause: err });
	}
	const sides = [
		2048,
		1536,
		1280,
		1024,
		800
	];
	const qualities = [
		80,
		70,
		60,
		50,
		40
	];
	let smallest = null;
	for (const side of sides) for (const quality of qualities) try {
		const out = await resizeToJpeg({
			buffer: source,
			maxSide: side,
			quality,
			withoutEnlargement: true
		});
		const size = out.length;
		if (!smallest || size < smallest.size) smallest = {
			buffer: out,
			size,
			resizeSide: side,
			quality
		};
		if (size <= maxBytes) return {
			buffer: out,
			optimizedSize: size,
			resizeSide: side,
			quality
		};
	} catch {}
	if (smallest) return {
		buffer: smallest.buffer,
		optimizedSize: smallest.size,
		resizeSide: smallest.resizeSide,
		quality: smallest.quality
	};
	throw new Error("Failed to optimize image");
}

//#endregion
//#region src/markdown/ir.ts
function createMarkdownIt(options) {
	const md = new MarkdownIt({
		html: false,
		linkify: options.linkify ?? true,
		breaks: false,
		typographer: false
	});
	md.enable("strikethrough");
	if (options.tableMode && options.tableMode !== "off") md.enable("table");
	else md.disable("table");
	if (options.autolink === false) md.disable("autolink");
	return md;
}
function getAttr(token, name) {
	if (token.attrGet) return token.attrGet(name);
	if (token.attrs) {
		for (const [key, value] of token.attrs) if (key === name) return value;
	}
	return null;
}
function createTextToken(base, content) {
	return {
		...base,
		type: "text",
		content,
		children: void 0
	};
}
function applySpoilerTokens(tokens) {
	for (const token of tokens) if (token.children && token.children.length > 0) token.children = injectSpoilersIntoInline(token.children);
}
function injectSpoilersIntoInline(tokens) {
	let totalDelims = 0;
	for (const token of tokens) {
		if (token.type !== "text") continue;
		const content = token.content ?? "";
		let i = 0;
		while (i < content.length) {
			const next = content.indexOf("||", i);
			if (next === -1) break;
			totalDelims += 1;
			i = next + 2;
		}
	}
	if (totalDelims < 2) return tokens;
	const usableDelims = totalDelims - totalDelims % 2;
	const result = [];
	const state = { spoilerOpen: false };
	let consumedDelims = 0;
	for (const token of tokens) {
		if (token.type !== "text") {
			result.push(token);
			continue;
		}
		const content = token.content ?? "";
		if (!content.includes("||")) {
			result.push(token);
			continue;
		}
		let index = 0;
		while (index < content.length) {
			const next = content.indexOf("||", index);
			if (next === -1) {
				if (index < content.length) result.push(createTextToken(token, content.slice(index)));
				break;
			}
			if (consumedDelims >= usableDelims) {
				result.push(createTextToken(token, content.slice(index)));
				break;
			}
			if (next > index) result.push(createTextToken(token, content.slice(index, next)));
			consumedDelims += 1;
			state.spoilerOpen = !state.spoilerOpen;
			result.push({ type: state.spoilerOpen ? "spoiler_open" : "spoiler_close" });
			index = next + 2;
		}
	}
	return result;
}
function initRenderTarget() {
	return {
		text: "",
		styles: [],
		openStyles: [],
		links: [],
		linkStack: []
	};
}
function resolveRenderTarget(state) {
	return state.table?.currentCell ?? state;
}
function appendText(state, value) {
	if (!value) return;
	const target = resolveRenderTarget(state);
	target.text += value;
}
function openStyle(state, style) {
	const target = resolveRenderTarget(state);
	target.openStyles.push({
		style,
		start: target.text.length
	});
}
function closeStyle(state, style) {
	const target = resolveRenderTarget(state);
	for (let i = target.openStyles.length - 1; i >= 0; i -= 1) if (target.openStyles[i]?.style === style) {
		const start = target.openStyles[i].start;
		target.openStyles.splice(i, 1);
		const end = target.text.length;
		if (end > start) target.styles.push({
			start,
			end,
			style
		});
		return;
	}
}
function appendParagraphSeparator(state) {
	if (state.env.listStack.length > 0) return;
	if (state.table) return;
	state.text += "\n\n";
}
function appendListPrefix(state) {
	const stack = state.env.listStack;
	const top = stack[stack.length - 1];
	if (!top) return;
	top.index += 1;
	const indent = "  ".repeat(Math.max(0, stack.length - 1));
	const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
	state.text += `${indent}${prefix}`;
}
function renderInlineCode(state, content) {
	if (!content) return;
	const target = resolveRenderTarget(state);
	const start = target.text.length;
	target.text += content;
	target.styles.push({
		start,
		end: start + content.length,
		style: "code"
	});
}
function renderCodeBlock(state, content) {
	let code = content ?? "";
	if (!code.endsWith("\n")) code = `${code}\n`;
	const target = resolveRenderTarget(state);
	const start = target.text.length;
	target.text += code;
	target.styles.push({
		start,
		end: start + code.length,
		style: "code_block"
	});
	if (state.env.listStack.length === 0) target.text += "\n";
}
function handleLinkClose(state) {
	const target = resolveRenderTarget(state);
	const link = target.linkStack.pop();
	if (!link?.href) return;
	const href = link.href.trim();
	if (!href) return;
	const start = link.labelStart;
	const end = target.text.length;
	if (end <= start) {
		target.links.push({
			start,
			end,
			href
		});
		return;
	}
	target.links.push({
		start,
		end,
		href
	});
}
function initTableState() {
	return {
		headers: [],
		rows: [],
		currentRow: [],
		currentCell: null,
		inHeader: false
	};
}
function finishTableCell(cell) {
	closeRemainingStyles(cell);
	return {
		text: cell.text,
		styles: cell.styles,
		links: cell.links
	};
}
function trimCell(cell) {
	const text = cell.text;
	let start = 0;
	let end = text.length;
	while (start < end && /\s/.test(text[start] ?? "")) start += 1;
	while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
	if (start === 0 && end === text.length) return cell;
	const trimmedText = text.slice(start, end);
	const trimmedLength = trimmedText.length;
	const trimmedStyles = [];
	for (const span of cell.styles) {
		const sliceStart = Math.max(0, span.start - start);
		const sliceEnd = Math.min(trimmedLength, span.end - start);
		if (sliceEnd > sliceStart) trimmedStyles.push({
			start: sliceStart,
			end: sliceEnd,
			style: span.style
		});
	}
	const trimmedLinks = [];
	for (const span of cell.links) {
		const sliceStart = Math.max(0, span.start - start);
		const sliceEnd = Math.min(trimmedLength, span.end - start);
		if (sliceEnd > sliceStart) trimmedLinks.push({
			start: sliceStart,
			end: sliceEnd,
			href: span.href
		});
	}
	return {
		text: trimmedText,
		styles: trimmedStyles,
		links: trimmedLinks
	};
}
function appendCell(state, cell) {
	if (!cell.text) return;
	const start = state.text.length;
	state.text += cell.text;
	for (const span of cell.styles) state.styles.push({
		start: start + span.start,
		end: start + span.end,
		style: span.style
	});
	for (const link of cell.links) state.links.push({
		start: start + link.start,
		end: start + link.end,
		href: link.href
	});
}
function appendCellTextOnly(state, cell) {
	if (!cell.text) return;
	state.text += cell.text;
}
function renderTableAsBullets(state) {
	if (!state.table) return;
	const headers = state.table.headers.map(trimCell);
	const rows = state.table.rows.map((row) => row.map(trimCell));
	if (headers.length === 0 && rows.length === 0) return;
	if (headers.length > 1 && rows.length > 0) for (const row of rows) {
		if (row.length === 0) continue;
		const rowLabel = row[0];
		if (rowLabel?.text) {
			const labelStart = state.text.length;
			appendCell(state, rowLabel);
			const labelEnd = state.text.length;
			if (labelEnd > labelStart) state.styles.push({
				start: labelStart,
				end: labelEnd,
				style: "bold"
			});
			state.text += "\n";
		}
		for (let i = 1; i < row.length; i++) {
			const header = headers[i];
			const value = row[i];
			if (!value?.text) continue;
			state.text += "• ";
			if (header?.text) {
				appendCell(state, header);
				state.text += ": ";
			} else state.text += `Column ${i}: `;
			appendCell(state, value);
			state.text += "\n";
		}
		state.text += "\n";
	}
	else for (const row of rows) {
		for (let i = 0; i < row.length; i++) {
			const header = headers[i];
			const value = row[i];
			if (!value?.text) continue;
			state.text += "• ";
			if (header?.text) {
				appendCell(state, header);
				state.text += ": ";
			}
			appendCell(state, value);
			state.text += "\n";
		}
		state.text += "\n";
	}
}
function renderTableAsCode(state) {
	if (!state.table) return;
	const headers = state.table.headers.map(trimCell);
	const rows = state.table.rows.map((row) => row.map(trimCell));
	const columnCount = Math.max(headers.length, ...rows.map((row) => row.length));
	if (columnCount === 0) return;
	const widths = Array.from({ length: columnCount }, () => 0);
	const updateWidths = (cells) => {
		for (let i = 0; i < columnCount; i += 1) {
			const width = cells[i]?.text.length ?? 0;
			if (widths[i] < width) widths[i] = width;
		}
	};
	updateWidths(headers);
	for (const row of rows) updateWidths(row);
	const codeStart = state.text.length;
	const appendRow = (cells) => {
		state.text += "|";
		for (let i = 0; i < columnCount; i += 1) {
			state.text += " ";
			const cell = cells[i];
			if (cell) appendCellTextOnly(state, cell);
			const pad = widths[i] - (cell?.text.length ?? 0);
			if (pad > 0) state.text += " ".repeat(pad);
			state.text += " |";
		}
		state.text += "\n";
	};
	const appendDivider = () => {
		state.text += "|";
		for (let i = 0; i < columnCount; i += 1) {
			const dashCount = Math.max(3, widths[i]);
			state.text += ` ${"-".repeat(dashCount)} |`;
		}
		state.text += "\n";
	};
	appendRow(headers);
	appendDivider();
	for (const row of rows) appendRow(row);
	const codeEnd = state.text.length;
	if (codeEnd > codeStart) state.styles.push({
		start: codeStart,
		end: codeEnd,
		style: "code_block"
	});
	if (state.env.listStack.length === 0) state.text += "\n";
}
function renderTokens(tokens, state) {
	for (const token of tokens) switch (token.type) {
		case "inline":
			if (token.children) renderTokens(token.children, state);
			break;
		case "text":
			appendText(state, token.content ?? "");
			break;
		case "em_open":
			openStyle(state, "italic");
			break;
		case "em_close":
			closeStyle(state, "italic");
			break;
		case "strong_open":
			openStyle(state, "bold");
			break;
		case "strong_close":
			closeStyle(state, "bold");
			break;
		case "s_open":
			openStyle(state, "strikethrough");
			break;
		case "s_close":
			closeStyle(state, "strikethrough");
			break;
		case "code_inline":
			renderInlineCode(state, token.content ?? "");
			break;
		case "spoiler_open":
			if (state.enableSpoilers) openStyle(state, "spoiler");
			break;
		case "spoiler_close":
			if (state.enableSpoilers) closeStyle(state, "spoiler");
			break;
		case "link_open": {
			const href = getAttr(token, "href") ?? "";
			const target = resolveRenderTarget(state);
			target.linkStack.push({
				href,
				labelStart: target.text.length
			});
			break;
		}
		case "link_close":
			handleLinkClose(state);
			break;
		case "image":
			appendText(state, token.content ?? "");
			break;
		case "softbreak":
		case "hardbreak":
			appendText(state, "\n");
			break;
		case "paragraph_close":
			appendParagraphSeparator(state);
			break;
		case "heading_open":
			if (state.headingStyle === "bold") openStyle(state, "bold");
			break;
		case "heading_close":
			if (state.headingStyle === "bold") closeStyle(state, "bold");
			appendParagraphSeparator(state);
			break;
		case "blockquote_open":
			if (state.blockquotePrefix) state.text += state.blockquotePrefix;
			openStyle(state, "blockquote");
			break;
		case "blockquote_close":
			closeStyle(state, "blockquote");
			break;
		case "bullet_list_open":
			if (state.env.listStack.length > 0) state.text += "\n";
			state.env.listStack.push({
				type: "bullet",
				index: 0
			});
			break;
		case "bullet_list_close":
			state.env.listStack.pop();
			if (state.env.listStack.length === 0) state.text += "\n";
			break;
		case "ordered_list_open": {
			if (state.env.listStack.length > 0) state.text += "\n";
			const start = Number(getAttr(token, "start") ?? "1");
			state.env.listStack.push({
				type: "ordered",
				index: start - 1
			});
			break;
		}
		case "ordered_list_close":
			state.env.listStack.pop();
			if (state.env.listStack.length === 0) state.text += "\n";
			break;
		case "list_item_open":
			appendListPrefix(state);
			break;
		case "list_item_close":
			if (!state.text.endsWith("\n")) state.text += "\n";
			break;
		case "code_block":
		case "fence":
			renderCodeBlock(state, token.content ?? "");
			break;
		case "html_block":
		case "html_inline":
			appendText(state, token.content ?? "");
			break;
		case "table_open":
			if (state.tableMode !== "off") {
				state.table = initTableState();
				state.hasTables = true;
			}
			break;
		case "table_close":
			if (state.table) {
				if (state.tableMode === "bullets") renderTableAsBullets(state);
				else if (state.tableMode === "code") renderTableAsCode(state);
			}
			state.table = null;
			break;
		case "thead_open":
			if (state.table) state.table.inHeader = true;
			break;
		case "thead_close":
			if (state.table) state.table.inHeader = false;
			break;
		case "tbody_open":
		case "tbody_close": break;
		case "tr_open":
			if (state.table) state.table.currentRow = [];
			break;
		case "tr_close":
			if (state.table) {
				if (state.table.inHeader) state.table.headers = state.table.currentRow;
				else state.table.rows.push(state.table.currentRow);
				state.table.currentRow = [];
			}
			break;
		case "th_open":
		case "td_open":
			if (state.table) state.table.currentCell = initRenderTarget();
			break;
		case "th_close":
		case "td_close":
			if (state.table?.currentCell) {
				state.table.currentRow.push(finishTableCell(state.table.currentCell));
				state.table.currentCell = null;
			}
			break;
		case "hr":
			state.text += "───\n\n";
			break;
		default:
			if (token.children) renderTokens(token.children, state);
			break;
	}
}
function closeRemainingStyles(target) {
	for (let i = target.openStyles.length - 1; i >= 0; i -= 1) {
		const open = target.openStyles[i];
		const end = target.text.length;
		if (end > open.start) target.styles.push({
			start: open.start,
			end,
			style: open.style
		});
	}
	target.openStyles = [];
}
function clampStyleSpans(spans, maxLength) {
	const clamped = [];
	for (const span of spans) {
		const start = Math.max(0, Math.min(span.start, maxLength));
		const end = Math.max(start, Math.min(span.end, maxLength));
		if (end > start) clamped.push({
			start,
			end,
			style: span.style
		});
	}
	return clamped;
}
function clampLinkSpans(spans, maxLength) {
	const clamped = [];
	for (const span of spans) {
		const start = Math.max(0, Math.min(span.start, maxLength));
		const end = Math.max(start, Math.min(span.end, maxLength));
		if (end > start) clamped.push({
			start,
			end,
			href: span.href
		});
	}
	return clamped;
}
function mergeStyleSpans(spans) {
	const sorted = [...spans].toSorted((a, b) => {
		if (a.start !== b.start) return a.start - b.start;
		if (a.end !== b.end) return a.end - b.end;
		return a.style.localeCompare(b.style);
	});
	const merged = [];
	for (const span of sorted) {
		const prev = merged[merged.length - 1];
		if (prev && prev.style === span.style && (span.start < prev.end || span.start === prev.end && span.style !== "blockquote")) {
			prev.end = Math.max(prev.end, span.end);
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}
function sliceStyleSpans(spans, start, end) {
	if (spans.length === 0) return [];
	const sliced = [];
	for (const span of spans) {
		const sliceStart = Math.max(span.start, start);
		const sliceEnd = Math.min(span.end, end);
		if (sliceEnd > sliceStart) sliced.push({
			start: sliceStart - start,
			end: sliceEnd - start,
			style: span.style
		});
	}
	return mergeStyleSpans(sliced);
}
function sliceLinkSpans(spans, start, end) {
	if (spans.length === 0) return [];
	const sliced = [];
	for (const span of spans) {
		const sliceStart = Math.max(span.start, start);
		const sliceEnd = Math.min(span.end, end);
		if (sliceEnd > sliceStart) sliced.push({
			start: sliceStart - start,
			end: sliceEnd - start,
			href: span.href
		});
	}
	return sliced;
}
function markdownToIR(markdown, options = {}) {
	return markdownToIRWithMeta(markdown, options).ir;
}
function markdownToIRWithMeta(markdown, options = {}) {
	const env = { listStack: [] };
	const tokens = createMarkdownIt(options).parse(markdown ?? "", env);
	if (options.enableSpoilers) applySpoilerTokens(tokens);
	const tableMode = options.tableMode ?? "off";
	const state = {
		text: "",
		styles: [],
		openStyles: [],
		links: [],
		linkStack: [],
		env,
		headingStyle: options.headingStyle ?? "none",
		blockquotePrefix: options.blockquotePrefix ?? "",
		enableSpoilers: options.enableSpoilers ?? false,
		tableMode,
		table: null,
		hasTables: false
	};
	renderTokens(tokens, state);
	closeRemainingStyles(state);
	const trimmedLength = state.text.trimEnd().length;
	let codeBlockEnd = 0;
	for (const span of state.styles) {
		if (span.style !== "code_block") continue;
		if (span.end > codeBlockEnd) codeBlockEnd = span.end;
	}
	const finalLength = Math.max(trimmedLength, codeBlockEnd);
	return {
		ir: {
			text: finalLength === state.text.length ? state.text : state.text.slice(0, finalLength),
			styles: mergeStyleSpans(clampStyleSpans(state.styles, finalLength)),
			links: clampLinkSpans(state.links, finalLength)
		},
		hasTables: state.hasTables
	};
}
function chunkMarkdownIR(ir, limit) {
	if (!ir.text) return [];
	if (limit <= 0 || ir.text.length <= limit) return [ir];
	const chunks = chunkText(ir.text, limit);
	const results = [];
	let cursor = 0;
	chunks.forEach((chunk, index) => {
		if (!chunk) return;
		if (index > 0) while (cursor < ir.text.length && /\s/.test(ir.text[cursor] ?? "")) cursor += 1;
		const start = cursor;
		const end = Math.min(ir.text.length, start + chunk.length);
		results.push({
			text: chunk,
			styles: sliceStyleSpans(ir.styles, start, end),
			links: sliceLinkSpans(ir.links, start, end)
		});
		cursor = end;
	});
	return results;
}

//#endregion
export { loadWebMedia as a, getDefaultLocalRoots as i, markdownToIR as n, loadWebMediaRaw as o, markdownToIRWithMeta as r, chunkMarkdownIR as t };