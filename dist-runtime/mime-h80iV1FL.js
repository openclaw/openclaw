import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
//#region src/media/constants.ts
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
function mediaKindFromMime(mime) {
	if (!mime) {return;}
	if (mime.startsWith("image/")) {return "image";}
	if (mime.startsWith("audio/")) {return "audio";}
	if (mime.startsWith("video/")) {return "video";}
	if (mime === "application/pdf") {return "document";}
	if (mime.startsWith("text/")) {return "document";}
	if (mime.startsWith("application/")) {return "document";}
}
function maxBytesForKind(kind) {
	switch (kind) {
		case "image": return MAX_IMAGE_BYTES;
		case "audio": return MAX_AUDIO_BYTES;
		case "video": return MAX_VIDEO_BYTES;
		case "document": return MAX_DOCUMENT_BYTES;
		default: return MAX_DOCUMENT_BYTES;
	}
}
//#endregion
//#region src/media/mime.ts
const EXT_BY_MIME = {
	"image/heic": ".heic",
	"image/heif": ".heif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"audio/ogg": ".ogg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/flac": ".flac",
	"audio/aac": ".aac",
	"audio/opus": ".opus",
	"audio/x-m4a": ".m4a",
	"audio/mp4": ".m4a",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"application/pdf": ".pdf",
	"application/json": ".json",
	"application/zip": ".zip",
	"application/gzip": ".gz",
	"application/x-tar": ".tar",
	"application/x-7z-compressed": ".7z",
	"application/vnd.rar": ".rar",
	"application/msword": ".doc",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"text/csv": ".csv",
	"text/plain": ".txt",
	"text/markdown": ".md"
};
const MIME_BY_EXT = {
	...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
	".jpeg": "image/jpeg",
	".js": "text/javascript"
};
const AUDIO_FILE_EXTENSIONS = new Set([
	".aac",
	".caf",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".ogg",
	".opus",
	".wav"
]);
function normalizeMimeType(mime) {
	if (!mime) {return;}
	return mime.split(";")[0]?.trim().toLowerCase() || void 0;
}
async function sniffMime(buffer) {
	if (!buffer) {return;}
	try {
		return (await fileTypeFromBuffer(buffer))?.mime ?? void 0;
	} catch {
		return;
	}
}
function getFileExtension(filePath) {
	if (!filePath) {return;}
	try {
		if (/^https?:\/\//i.test(filePath)) {
			const url = new URL(filePath);
			return path.extname(url.pathname).toLowerCase() || void 0;
		}
	} catch {}
	return path.extname(filePath).toLowerCase() || void 0;
}
function isAudioFileName(fileName) {
	const ext = getFileExtension(fileName);
	if (!ext) {return false;}
	return AUDIO_FILE_EXTENSIONS.has(ext);
}
function detectMime(opts) {
	return detectMimeImpl(opts);
}
function isGenericMime(mime) {
	if (!mime) {return true;}
	const m = mime.toLowerCase();
	return m === "application/octet-stream" || m === "application/zip";
}
async function detectMimeImpl(opts) {
	const ext = getFileExtension(opts.filePath);
	const extMime = ext ? MIME_BY_EXT[ext] : void 0;
	const headerMime = normalizeMimeType(opts.headerMime);
	const sniffed = await sniffMime(opts.buffer);
	if (sniffed && (!isGenericMime(sniffed) || !extMime)) {return sniffed;}
	if (extMime) {return extMime;}
	if (headerMime && !isGenericMime(headerMime)) {return headerMime;}
	if (sniffed) {return sniffed;}
	if (headerMime) {return headerMime;}
}
function extensionForMime(mime) {
	const normalized = normalizeMimeType(mime);
	if (!normalized) {return;}
	return EXT_BY_MIME[normalized];
}
function isGifMedia(opts) {
	if (opts.contentType?.toLowerCase() === "image/gif") {return true;}
	return getFileExtension(opts.fileName) === ".gif";
}
function imageMimeFromFormat(format) {
	if (!format) {return;}
	switch (format.toLowerCase()) {
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "heic": return "image/heic";
		case "heif": return "image/heif";
		case "png": return "image/png";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		default: return;
	}
}
function kindFromMime(mime) {
	return mediaKindFromMime(normalizeMimeType(mime));
}
//#endregion
export { isAudioFileName as a, normalizeMimeType as c, mediaKindFromMime as d, imageMimeFromFormat as i, MAX_IMAGE_BYTES as l, extensionForMime as n, isGifMedia as o, getFileExtension as r, kindFromMime as s, detectMime as t, maxBytesForKind as u };
