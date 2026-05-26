import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { n as detectMime } from "./mime-DppuT-pZ.js";
import { n as estimateBase64DecodedBytes, t as canonicalizeBase64 } from "./base64-D03BM6T6.js";
import { s as convertHeicToJpeg } from "./media-services-CLFjOJQs.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { n as readResponseWithLimit } from "./read-response-with-limit-S6PVjcFB.js";
import { t as extractPdfContent } from "./pdf-extract-Cb7tCN-u.js";
//#region src/media/input-files.ts
const DEFAULT_INPUT_IMAGE_MIMES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/heic",
	"image/heif"
];
const DEFAULT_INPUT_FILE_MIMES = [
	"text/plain",
	"text/markdown",
	"text/html",
	"text/csv",
	"application/json",
	"application/pdf"
];
const DEFAULT_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_INPUT_TIMEOUT_MS = 1e4;
const NORMALIZED_INPUT_IMAGE_MIME = "image/jpeg";
const HEIC_INPUT_IMAGE_MIMES = new Set(["image/heic", "image/heif"]);
function rejectOversizedBase64Payload(params) {
	const estimated = estimateBase64DecodedBytes(params.data);
	if (estimated > params.maxBytes) throw new Error(`${params.label} too large: ${estimated} bytes (limit: ${params.maxBytes} bytes)`);
}
function normalizeMimeType(value) {
	const [raw] = value?.split(";") ?? [];
	return normalizeOptionalLowercaseString(raw);
}
function parseContentType(value) {
	if (!value) return {};
	const parts = value.split(";").map((part) => part.trim());
	return {
		mimeType: normalizeMimeType(parts[0]),
		charset: parts.map((part) => normalizeOptionalString(part.match(/^charset=(.+)$/i)?.[1])).find((part) => part && part.length > 0)
	};
}
function normalizeMimeList(values, fallback) {
	const input = values && values.length > 0 ? values : fallback;
	return new Set(input.map((value) => normalizeMimeType(value)).filter(Boolean));
}
function resolveInputFileLimits(config) {
	return {
		allowUrl: config?.allowUrl ?? true,
		allowedMimes: normalizeMimeList(config?.allowedMimes, DEFAULT_INPUT_FILE_MIMES),
		maxBytes: config?.maxBytes ?? 5242880,
		maxChars: config?.maxChars ?? 6e4,
		maxRedirects: config?.maxRedirects ?? 3,
		timeoutMs: config?.timeoutMs ?? 1e4,
		pdf: {
			maxPages: config?.pdf?.maxPages ?? 4,
			maxPixels: config?.pdf?.maxPixels ?? 4e6,
			minTextChars: config?.pdf?.minTextChars ?? 200
		}
	};
}
async function fetchWithGuard(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		maxRedirects: params.maxRedirects,
		timeoutMs: params.timeoutMs,
		policy: params.policy,
		auditContext: params.auditContext,
		init: { headers: { "User-Agent": "OpenClaw-Gateway/1.0" } }
	});
	try {
		if (!response.ok) throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const size = Number(contentLength);
			if (Number.isFinite(size) && size > params.maxBytes) throw new Error(`Content too large: ${size} bytes (limit: ${params.maxBytes} bytes)`);
		}
		const buffer = await readResponseWithLimit(response, params.maxBytes);
		const contentType = response.headers.get("content-type") || void 0;
		return {
			buffer,
			mimeType: parseContentType(contentType).mimeType ?? "application/octet-stream",
			contentType
		};
	} finally {
		await release();
	}
}
function decodeTextContent(buffer, charset) {
	const encoding = normalizeOptionalLowercaseString(charset) || "utf-8";
	try {
		return new TextDecoder(encoding).decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}
function clampText(text, maxChars) {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}
async function normalizeInputImage(params) {
	const declaredMime = normalizeMimeType(params.mimeType) ?? "application/octet-stream";
	const detectedMime = normalizeMimeType(await detectMime({
		buffer: params.buffer,
		headerMime: params.mimeType
	}));
	if (declaredMime.startsWith("image/") && detectedMime && !detectedMime.startsWith("image/")) throw new Error(`Unsupported image MIME type: ${detectedMime}`);
	const sourceMime = detectedMime && HEIC_INPUT_IMAGE_MIMES.has(detectedMime) || HEIC_INPUT_IMAGE_MIMES.has(declaredMime) && !detectedMime ? detectedMime ?? declaredMime : declaredMime;
	if (!params.limits.allowedMimes.has(sourceMime)) throw new Error(`Unsupported image MIME type: ${sourceMime}`);
	if (!HEIC_INPUT_IMAGE_MIMES.has(sourceMime)) return {
		type: "image",
		data: params.buffer.toString("base64"),
		mimeType: sourceMime
	};
	const normalizedBuffer = await convertHeicToJpeg(params.buffer);
	if (normalizedBuffer.byteLength > params.limits.maxBytes) throw new Error(`Image too large after HEIC conversion: ${normalizedBuffer.byteLength} bytes (limit: ${params.limits.maxBytes} bytes)`);
	return {
		type: "image",
		data: normalizedBuffer.toString("base64"),
		mimeType: NORMALIZED_INPUT_IMAGE_MIME
	};
}
async function resolveInputFileMime(params) {
	const sniffedMime = normalizeMimeType(await detectMime({ buffer: params.buffer }));
	if (!sniffedMime) return params.declaredMime;
	if (sniffedMime === "application/octet-stream") return params.declaredMime ?? sniffedMime;
	return sniffedMime;
}
async function extractImageContentFromSource(source, limits) {
	if (source.type === "base64") {
		rejectOversizedBase64Payload({
			data: source.data,
			maxBytes: limits.maxBytes,
			label: "Image"
		});
		const canonicalData = canonicalizeBase64(source.data);
		if (!canonicalData) throw new Error("input_image base64 source has invalid 'data' field");
		const buffer = Buffer.from(canonicalData, "base64");
		if (buffer.byteLength > limits.maxBytes) throw new Error(`Image too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`);
		return await normalizeInputImage({
			buffer,
			mimeType: normalizeMimeType(source.mediaType) ?? "image/png",
			limits
		});
	}
	if (source.type === "url") {
		if (!limits.allowUrl) throw new Error("input_image URL sources are disabled by config");
		const result = await fetchWithGuard({
			url: source.url,
			maxBytes: limits.maxBytes,
			timeoutMs: limits.timeoutMs,
			maxRedirects: limits.maxRedirects,
			policy: {
				allowPrivateNetwork: false,
				hostnameAllowlist: limits.urlAllowlist
			},
			auditContext: "openresponses.input_image"
		});
		return await normalizeInputImage({
			buffer: result.buffer,
			mimeType: result.mimeType,
			limits
		});
	}
	throw new Error(`Unsupported input_image source type: ${source.type}`);
}
async function extractFileContentFromSource(params) {
	const { source, limits } = params;
	const filename = source.filename || "file";
	let buffer;
	let mimeType;
	let charset;
	if (source.type === "base64") {
		rejectOversizedBase64Payload({
			data: source.data,
			maxBytes: limits.maxBytes,
			label: "File"
		});
		const canonicalData = canonicalizeBase64(source.data);
		if (!canonicalData) throw new Error("input_file base64 source has invalid 'data' field");
		const parsed = parseContentType(source.mediaType);
		mimeType = parsed.mimeType;
		charset = parsed.charset;
		buffer = Buffer.from(canonicalData, "base64");
	} else {
		if (!limits.allowUrl) throw new Error("input_file URL sources are disabled by config");
		const result = await fetchWithGuard({
			url: source.url,
			maxBytes: limits.maxBytes,
			timeoutMs: limits.timeoutMs,
			maxRedirects: limits.maxRedirects,
			policy: {
				allowPrivateNetwork: false,
				hostnameAllowlist: limits.urlAllowlist
			},
			auditContext: "openresponses.input_file"
		});
		const parsed = parseContentType(result.contentType);
		mimeType = parsed.mimeType ?? normalizeMimeType(result.mimeType);
		charset = parsed.charset;
		buffer = result.buffer;
	}
	if (buffer.byteLength > limits.maxBytes) throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`);
	mimeType = await resolveInputFileMime({
		buffer,
		declaredMime: mimeType
	});
	if (!mimeType) throw new Error("input_file missing media type");
	if (!limits.allowedMimes.has(mimeType)) throw new Error(`Unsupported file MIME type: ${mimeType}`);
	if (mimeType === "application/pdf") {
		const extracted = await extractPdfContent({
			buffer,
			maxPages: limits.pdf.maxPages,
			maxPixels: limits.pdf.maxPixels,
			minTextChars: limits.pdf.minTextChars,
			...params.config ? { config: params.config } : {},
			onImageExtractionError: (err) => {
				logWarn(`media: PDF image extraction skipped, ${String(err)}`);
			}
		});
		return {
			filename,
			text: extracted.text ? clampText(extracted.text, limits.maxChars) : "",
			images: extracted.images.length > 0 ? extracted.images : void 0
		};
	}
	return {
		filename,
		text: clampText(decodeTextContent(buffer, charset), limits.maxChars)
	};
}
//#endregion
export { extractImageContentFromSource as a, resolveInputFileLimits as c, extractFileContentFromSource as i, DEFAULT_INPUT_IMAGE_MIMES as n, normalizeMimeList as o, DEFAULT_INPUT_TIMEOUT_MS as r, normalizeMimeType as s, DEFAULT_INPUT_IMAGE_MAX_BYTES as t };
