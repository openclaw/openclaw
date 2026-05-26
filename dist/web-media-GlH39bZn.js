import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { b as assertNoWindowsNetworkPath, w as safeFileURLToPath } from "./fs-safe-CV86zY9G.js";
import { i as readLocalFileSafely } from "./secure-temp-dir-aidxCRgA.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-YU5FjfZK.js";
import { a as getActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import "./local-file-access-CBe_wA_B.js";
import { c as kindFromMime, g as maxBytesForKind, i as getFileExtension, l as mimeTypeFromFilePath, n as detectMime, r as extensionForMime, u as normalizeMimeType } from "./mime-DppuT-pZ.js";
import { f as optimizeImageToPng, l as hasAlphaChannel, p as resizeToJpeg, s as convertHeicToJpeg, u as isImageProcessorUnavailableError } from "./media-services-CLFjOJQs.js";
import { n as extnameFromAnyPath, t as basenameFromAnyPath } from "./file-name-r4prf02z.js";
import { i as resolveInboundMediaReference, t as MediaReferenceError } from "./media-reference-efB9JQqF.js";
import { i as readRemoteMediaBuffer } from "./fetch-C0wRQZuz.js";
import { n as assertLocalMediaAllowed, t as LocalMediaAccessError } from "./local-media-access-Cfwhp6hG.js";
import path from "node:path";
//#region src/media/web-media.ts
async function resolveMediaStoreUriToPath(mediaUrl) {
	if (!/^media:\/\//i.test(mediaUrl)) return null;
	try {
		return (await resolveInboundMediaReference(mediaUrl))?.physicalPath ?? null;
	} catch (err) {
		if (err instanceof MediaReferenceError) throw new LocalMediaAccessError(err.code, err.message, { cause: err });
		throw err;
	}
}
async function resolveHostedPluginMediaUrl(mediaUrl) {
	const registry = getActivePluginRegistry();
	for (const entry of registry?.hostedMediaResolvers ?? []) try {
		const resolved = await entry.resolver(mediaUrl);
		if (typeof resolved === "string" && resolved.trim()) return resolved;
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`Hosted media resolver failed (${entry.pluginId ?? "unknown"}): ${formatErrorMessage(err)}`);
	}
	return null;
}
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
const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const HOST_READ_ALLOWED_DOCUMENT_MIMES = new Set([
	"application/msword",
	"application/pdf",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/gzip",
	"application/x-7z-compressed",
	"application/x-tar",
	"application/zip",
	"text/csv",
	"text/markdown"
]);
const HOST_READ_TEXT_PLAIN_ALIASES = new Set(["text/csv", "text/markdown"]);
const MB = 1024 * 1024;
function getTextStats(text) {
	if (!text) return { printableRatio: 0 };
	let printable = 0;
	let control = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 9 || code === 10 || code === 13 || code === 32) {
			printable += 1;
			continue;
		}
		if (code < 32 || code >= 127 && code <= 159) {
			control += 1;
			continue;
		}
		printable += 1;
	}
	const total = printable + control;
	if (total === 0) return { printableRatio: 0 };
	return { printableRatio: printable / total };
}
function hasSingleByteTextShape(buffer) {
	if (buffer.length === 0) return true;
	let asciiText = 0;
	let control = 0;
	for (const byte of buffer) {
		if (byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte <= 126) {
			asciiText += 1;
			continue;
		}
		if (byte < 32 || byte === 127) control += 1;
	}
	const total = buffer.length;
	const highBytes = total - asciiText - control;
	return control === 0 && asciiText / total >= .7 && highBytes / total <= .3;
}
function decodeHostReadText(buffer) {
	if (buffer.length === 0) return "";
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		if (!hasSingleByteTextShape(buffer)) return;
		return new TextDecoder("latin1").decode(buffer);
	}
}
function isValidatedHostReadText(buffer) {
	if (!buffer) return false;
	if (buffer.length === 0) return true;
	const text = decodeHostReadText(buffer);
	if (text === void 0) return false;
	const { printableRatio } = getTextStats(text);
	return printableRatio > .95;
}
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
function assertHostReadMediaAllowed(params) {
	const declaredMime = normalizeMimeType(mimeTypeFromFilePath(params.filePath));
	const normalizedMime = normalizeMimeType(params.contentType);
	if (declaredMime && HOST_READ_TEXT_PLAIN_ALIASES.has(declaredMime)) {
		if (!params.sniffedContentType && params.buffer && isValidatedHostReadText(params.buffer)) return;
		throw new LocalMediaAccessError("path-not-allowed", "hostReadCapability permits only validated plain-text CSV/Markdown documents for local reads");
	}
	const sniffedKind = kindFromMime(params.sniffedContentType);
	if (sniffedKind === "image" || sniffedKind === "audio" || sniffedKind === "video") return;
	const sniffedMime = normalizeMimeType(params.sniffedContentType);
	if (sniffedKind === "document" && sniffedMime && HOST_READ_ALLOWED_DOCUMENT_MIMES.has(sniffedMime)) return;
	if (sniffedMime === "application/x-cfb" && [
		".doc",
		".ppt",
		".xls"
	].includes(getFileExtension(params.filePath) ?? "")) return;
	if (!sniffedMime && normalizedMime && HOST_READ_TEXT_PLAIN_ALIASES.has(normalizedMime) && params.buffer && isValidatedHostReadText(params.buffer)) return;
	if (params.kind === "document" && normalizedMime && HOST_READ_ALLOWED_DOCUMENT_MIMES.has(normalizedMime)) throw new LocalMediaAccessError("path-not-allowed", `Host-local media sends require buffer-verified media/document types (got fallback ${normalizedMime}).`);
	throw new LocalMediaAccessError("path-not-allowed", `Host-local media sends only allow buffer-verified images, audio, video, PDF, Office documents, archives, CSV, and Markdown (got ${sniffedMime ?? normalizedMime ?? "unknown"}).`);
}
function toJpegFileName(fileName) {
	if (!fileName) return;
	const trimmed = basenameFromAnyPath(fileName.trim());
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
		logVerbose(`Optimized PNG (preserving alpha) from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side<=${params.optimized.resizeSide}px)`);
		return;
	}
	logVerbose(`Optimized media from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side<=${params.optimized.resizeSide}px, q=${params.optimized.quality})`);
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
	const { maxBytes, optimizeImages = true, ssrfPolicy, proxyUrl, fetchImpl, requestInit, readIdleTimeoutMs, trustExplicitProxyDns, workspaceDir, localRoots, sandboxValidated = false, readFile: readFileOverride, hostReadCapability = false } = options;
	if (!/^\s*media:\/\//i.test(mediaUrl)) mediaUrl = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
	mediaUrl = await resolveMediaStoreUriToPath(mediaUrl) ?? mediaUrl;
	if (mediaUrl.startsWith("file://")) try {
		mediaUrl = safeFileURLToPath(mediaUrl);
	} catch (err) {
		throw new LocalMediaAccessError("invalid-file-url", err.message, { cause: err });
	}
	mediaUrl = await resolveHostedPluginMediaUrl(mediaUrl) ?? mediaUrl;
	const optimizeAndClampImage = async (buffer, cap, meta) => {
		const originalSize = buffer.length;
		let optimized;
		try {
			optimized = await optimizeImageWithFallback({
				buffer,
				cap,
				meta
			});
		} catch (err) {
			if (isImageProcessorUnavailableError(err) && !isHeicSource(meta ?? {}) && buffer.length <= cap) {
				if (shouldLogVerbose()) logVerbose(`Image optimizer unavailable; sending original ${formatMb(buffer.length)}MB media without optimization`);
				return {
					buffer,
					contentType: meta?.contentType,
					kind: "image",
					fileName: meta?.fileName
				};
			}
			throw err;
		}
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
		const cap = maxBytes !== void 0 ? maxBytes : maxBytesForKind(params.kind ?? "document");
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
		const defaultFetchCap = maxBytesForKind("document");
		const { buffer, contentType, fileName } = await readRemoteMediaBuffer({
			url: mediaUrl,
			fetchImpl,
			requestInit,
			readIdleTimeoutMs,
			maxBytes: maxBytes === void 0 ? defaultFetchCap : optimizeImages ? Math.max(maxBytes, defaultFetchCap) : maxBytes,
			ssrfPolicy,
			dispatcherPolicy: proxyUrl ? {
				mode: "explicit-proxy",
				proxyUrl,
				allowPrivateProxy: true
			} : void 0,
			trustExplicitProxyDns
		});
		return await clampAndFinalize({
			buffer,
			contentType,
			kind: kindFromMime(contentType),
			fileName
		});
	}
	if (mediaUrl.startsWith("~")) mediaUrl = resolveUserPath(mediaUrl);
	if (workspaceDir && !path.isAbsolute(mediaUrl) && !WINDOWS_DRIVE_RE.test(mediaUrl)) mediaUrl = path.resolve(workspaceDir, mediaUrl);
	try {
		assertNoWindowsNetworkPath(mediaUrl, "Local media path");
	} catch (err) {
		throw new LocalMediaAccessError("network-path-not-allowed", err.message, { cause: err });
	}
	if ((sandboxValidated || localRoots === "any") && !readFileOverride) throw new LocalMediaAccessError("unsafe-bypass", "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.");
	if (!(sandboxValidated || localRoots === "any")) await assertLocalMediaAllowed(mediaUrl, localRoots);
	let data;
	if (readFileOverride) data = await readFileOverride(mediaUrl);
	else try {
		data = (await readLocalFileSafely({ filePath: mediaUrl })).buffer;
	} catch (err) {
		if (err instanceof FsSafeError) {
			if (err.code === "not-found") throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, { cause: err });
			if (err.code === "not-file") throw new LocalMediaAccessError("not-file", `Local media path is not a file: ${mediaUrl}`, { cause: err });
			throw new LocalMediaAccessError("invalid-path", `Local media path is not safe to read: ${mediaUrl}`, { cause: err });
		}
		throw err;
	}
	const sniffedMime = await detectMime({ buffer: data });
	const mime = await detectMime({
		buffer: data,
		filePath: mediaUrl
	});
	const kind = kindFromMime(mime);
	if (hostReadCapability) assertHostReadMediaAllowed({
		sniffedContentType: sniffedMime,
		contentType: mime,
		filePath: mediaUrl,
		kind,
		buffer: data
	});
	let fileName = basenameFromAnyPath(mediaUrl) || void 0;
	if (fileName && !extnameFromAnyPath(fileName) && mime) {
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
	let firstResizeError;
	const errors = [];
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
	} catch (err) {
		firstResizeError ??= err;
		const message = formatErrorMessage(err).trim();
		if (message && !errors.includes(message)) errors.push(message);
	}
	if (smallest) return {
		buffer: smallest.buffer,
		optimizedSize: smallest.size,
		resizeSide: smallest.resizeSide,
		quality: smallest.quality
	};
	if (isImageProcessorUnavailableError(firstResizeError)) throw firstResizeError;
	const detail = errors.length > 0 ? `: ${errors.slice(0, 3).join("; ")}` : "";
	throw new Error(`Failed to optimize image${detail}`, { cause: firstResizeError });
}
//#endregion
export { loadWebMediaRaw as n, optimizeImageToJpeg as r, loadWebMedia as t };
