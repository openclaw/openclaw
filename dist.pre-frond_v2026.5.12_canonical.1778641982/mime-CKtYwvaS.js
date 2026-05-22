import path from "node:path";
//#region extensions/file-transfer/src/shared/mime.ts
const EXTENSION_MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".heic": "image/heic",
	".heif": "image/heif",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".log": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".html": "text/html",
	".xml": "application/xml",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip"
};
const IMAGE_MIME_INLINE_SET = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
const TEXT_INLINE_MIME_SET = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"text/html",
	"application/json",
	"application/xml"
]);
const TEXT_INLINE_MAX_BYTES = 8 * 1024;
function mimeFromExtension(filePath) {
	return EXTENSION_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
//#endregion
export { mimeFromExtension as a, TEXT_INLINE_MIME_SET as i, IMAGE_MIME_INLINE_SET as n, TEXT_INLINE_MAX_BYTES as r, EXTENSION_MIME as t };
