import { t as createSubsystemLogger } from "./subsystem-CYLd4dcj.js";
import { i as getImageMetadata, n as buildImageResizeSideGrid, s as resizeToJpeg, t as IMAGE_REDUCE_QUALITY_STEPS } from "./image-ops-D98Q4dLq.js";

//#region src/media/base64.ts
function estimateBase64DecodedBytes(base64) {
	let effectiveLen = 0;
	for (let i = 0; i < base64.length; i += 1) {
		if (base64.charCodeAt(i) <= 32) continue;
		effectiveLen += 1;
	}
	if (effectiveLen === 0) return 0;
	let padding = 0;
	let end = base64.length - 1;
	while (end >= 0 && base64.charCodeAt(end) <= 32) end -= 1;
	if (end >= 0 && base64[end] === "=") {
		padding = 1;
		end -= 1;
		while (end >= 0 && base64.charCodeAt(end) <= 32) end -= 1;
		if (end >= 0 && base64[end] === "=") padding = 2;
	}
	const estimated = Math.floor(effectiveLen * 3 / 4) - padding;
	return Math.max(0, estimated);
}
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;
/**
* Normalize and validate a base64 string.
* Returns canonical base64 (no whitespace) or undefined when invalid.
*/
function canonicalizeBase64(base64) {
	const cleaned = base64.replace(/\s+/g, "");
	if (!cleaned || cleaned.length % 4 !== 0 || !BASE64_CHARS_RE.test(cleaned)) return;
	return cleaned;
}

//#endregion
//#region src/agents/image-sanitization.ts
const DEFAULT_IMAGE_MAX_DIMENSION_PX = 1200;
const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
function resolveImageSanitizationLimits(cfg) {
	const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
	if (typeof configured !== "number" || !Number.isFinite(configured)) return {};
	return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}

//#endregion
//#region src/agents/tool-images.ts
const MAX_IMAGE_DIMENSION_PX = DEFAULT_IMAGE_MAX_DIMENSION_PX;
const MAX_IMAGE_BYTES = DEFAULT_IMAGE_MAX_BYTES;
const log = createSubsystemLogger("agents/tool-images");
function isImageBlock(block) {
	if (!block || typeof block !== "object") return false;
	const rec = block;
	return rec.type === "image" && typeof rec.data === "string" && typeof rec.mimeType === "string";
}
function isTextBlock(block) {
	if (!block || typeof block !== "object") return false;
	const rec = block;
	return rec.type === "text" && typeof rec.text === "string";
}
function inferMimeTypeFromBase64(base64) {
	const trimmed = base64.trim();
	if (!trimmed) return;
	if (trimmed.startsWith("/9j/")) return "image/jpeg";
	if (trimmed.startsWith("iVBOR")) return "image/png";
	if (trimmed.startsWith("R0lGOD")) return "image/gif";
}
function formatBytesShort(bytes) {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
function parseMediaPathFromText(text) {
	for (const line of text.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("MEDIA:")) continue;
		const raw = trimmed.slice(6).trim();
		if (!raw) continue;
		return (raw.match(/^`([^`]+)`$/u)?.[1] ?? raw).trim();
	}
}
function fileNameFromPathLike(pathLike) {
	const value = pathLike.trim();
	if (!value) return;
	try {
		const candidate = new URL(value).pathname.split("/").filter(Boolean).at(-1);
		return candidate && candidate.length > 0 ? candidate : void 0;
	} catch {}
	const candidate = value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
	return candidate && candidate.length > 0 ? candidate : void 0;
}
function inferImageFileName(params) {
	const rec = params.block;
	for (const key of [
		"fileName",
		"filename",
		"path",
		"url"
	]) {
		const raw = rec[key];
		if (typeof raw !== "string" || raw.trim().length === 0) continue;
		const candidate = fileNameFromPathLike(raw);
		if (candidate) return candidate;
	}
	if (typeof rec.name === "string" && rec.name.trim().length > 0) return rec.name.trim();
	if (params.mediaPathHint) {
		const candidate = fileNameFromPathLike(params.mediaPathHint);
		if (candidate) return candidate;
	}
	if (typeof params.label === "string" && params.label.startsWith("read:")) {
		const candidate = fileNameFromPathLike(params.label.slice(5));
		if (candidate) return candidate;
	}
}
async function resizeImageBase64IfNeeded(params) {
	const buf = Buffer.from(params.base64, "base64");
	const meta = await getImageMetadata(buf);
	const width = meta?.width;
	const height = meta?.height;
	const overBytes = buf.byteLength > params.maxBytes;
	const hasDimensions = typeof width === "number" && typeof height === "number";
	const overDimensions = hasDimensions && (width > params.maxDimensionPx || height > params.maxDimensionPx);
	if (hasDimensions && !overBytes && width <= params.maxDimensionPx && height <= params.maxDimensionPx) return {
		base64: params.base64,
		mimeType: params.mimeType,
		resized: false,
		width,
		height
	};
	const maxDim = hasDimensions ? Math.max(width ?? 0, height ?? 0) : params.maxDimensionPx;
	const sideStart = maxDim > 0 ? Math.min(params.maxDimensionPx, maxDim) : params.maxDimensionPx;
	const sideGrid = buildImageResizeSideGrid(params.maxDimensionPx, sideStart);
	let smallest = null;
	for (const side of sideGrid) for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
		const out = await resizeToJpeg({
			buffer: buf,
			maxSide: side,
			quality,
			withoutEnlargement: true
		});
		if (!smallest || out.byteLength < smallest.size) smallest = {
			buffer: out,
			size: out.byteLength
		};
		if (out.byteLength <= params.maxBytes) {
			const sourcePixels = typeof width === "number" && typeof height === "number" ? `${width}x${height}px` : "unknown";
			const sourceWithFile = params.fileName ? `${params.fileName} ${sourcePixels}` : sourcePixels;
			const byteReductionPct = buf.byteLength > 0 ? Number(((buf.byteLength - out.byteLength) / buf.byteLength * 100).toFixed(1)) : 0;
			log.info(`Image resized to fit limits: ${sourceWithFile} ${formatBytesShort(buf.byteLength)} -> ${formatBytesShort(out.byteLength)} (-${byteReductionPct}%)`, {
				label: params.label,
				fileName: params.fileName,
				sourceMimeType: params.mimeType,
				sourceWidth: width,
				sourceHeight: height,
				sourceBytes: buf.byteLength,
				maxBytes: params.maxBytes,
				maxDimensionPx: params.maxDimensionPx,
				triggerOverBytes: overBytes,
				triggerOverDimensions: overDimensions,
				outputMimeType: "image/jpeg",
				outputBytes: out.byteLength,
				outputQuality: quality,
				outputMaxSide: side,
				byteReductionPct
			});
			return {
				base64: out.toString("base64"),
				mimeType: "image/jpeg",
				resized: true,
				width,
				height
			};
		}
	}
	const best = smallest?.buffer ?? buf;
	const maxMb = (params.maxBytes / (1024 * 1024)).toFixed(0);
	const gotMb = (best.byteLength / (1024 * 1024)).toFixed(2);
	const sourcePixels = typeof width === "number" && typeof height === "number" ? `${width}x${height}px` : "unknown";
	const sourceWithFile = params.fileName ? `${params.fileName} ${sourcePixels}` : sourcePixels;
	log.warn(`Image resize failed to fit limits: ${sourceWithFile} best=${formatBytesShort(best.byteLength)} limit=${formatBytesShort(params.maxBytes)}`, {
		label: params.label,
		fileName: params.fileName,
		sourceMimeType: params.mimeType,
		sourceWidth: width,
		sourceHeight: height,
		sourceBytes: buf.byteLength,
		maxDimensionPx: params.maxDimensionPx,
		maxBytes: params.maxBytes,
		smallestCandidateBytes: best.byteLength,
		triggerOverBytes: overBytes,
		triggerOverDimensions: overDimensions
	});
	throw new Error(`Image could not be reduced below ${maxMb}MB (got ${gotMb}MB)`);
}
async function sanitizeContentBlocksImages(blocks, label, opts = {}) {
	const maxDimensionPx = Math.max(opts.maxDimensionPx ?? MAX_IMAGE_DIMENSION_PX, 1);
	const maxBytes = Math.max(opts.maxBytes ?? MAX_IMAGE_BYTES, 1);
	const out = [];
	let mediaPathHint;
	for (const block of blocks) {
		if (isTextBlock(block)) {
			const mediaPath = parseMediaPathFromText(block.text);
			if (mediaPath) mediaPathHint = mediaPath;
		}
		if (!isImageBlock(block)) {
			out.push(block);
			continue;
		}
		const data = block.data.trim();
		if (!data) {
			out.push({
				type: "text",
				text: `[${label}] omitted empty image payload`
			});
			continue;
		}
		const canonicalData = canonicalizeBase64(data);
		if (!canonicalData) {
			out.push({
				type: "text",
				text: `[${label}] omitted image payload: invalid base64`
			});
			continue;
		}
		try {
			const mimeType = inferMimeTypeFromBase64(canonicalData) ?? block.mimeType;
			const resized = await resizeImageBase64IfNeeded({
				base64: canonicalData,
				mimeType,
				maxDimensionPx,
				maxBytes,
				label,
				fileName: inferImageFileName({
					block,
					label,
					mediaPathHint
				})
			});
			out.push({
				...block,
				data: resized.base64,
				mimeType: resized.resized ? resized.mimeType : mimeType
			});
		} catch (err) {
			out.push({
				type: "text",
				text: `[${label}] omitted image payload: ${String(err)}`
			});
		}
	}
	return out;
}
async function sanitizeImageBlocks(images, label, opts = {}) {
	if (images.length === 0) return {
		images,
		dropped: 0
	};
	const next = (await sanitizeContentBlocksImages(images, label, opts)).filter(isImageBlock);
	return {
		images: next,
		dropped: Math.max(0, images.length - next.length)
	};
}
async function sanitizeToolResultImages(result, label, opts = {}) {
	const content = Array.isArray(result.content) ? result.content : [];
	if (!content.some((b) => isImageBlock(b) || isTextBlock(b))) return result;
	const next = await sanitizeContentBlocksImages(content, label, opts);
	return {
		...result,
		content: next
	};
}

//#endregion
export { canonicalizeBase64 as a, resolveImageSanitizationLimits as i, sanitizeImageBlocks as n, estimateBase64DecodedBytes as o, sanitizeToolResultImages as r, sanitizeContentBlocksImages as t };