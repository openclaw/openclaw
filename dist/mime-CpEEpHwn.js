import { l as mimeTypeFromFilePath } from "./mime-Bg_OIUJn.js";
import "./media-mime-C13b9Hj2.js";
//#region extensions/file-transfer/src/shared/mime.ts
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
	"application/xml",
	"text/xml"
]);
const TEXT_INLINE_MAX_BYTES = 8 * 1024;
function mimeFromExtension(filePath) {
	return mimeTypeFromFilePath(filePath) ?? "application/octet-stream";
}
//#endregion
export { mimeFromExtension as i, TEXT_INLINE_MAX_BYTES as n, TEXT_INLINE_MIME_SET as r, IMAGE_MIME_INLINE_SET as t };
