import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import path from "node:path";
//#region src/shared/avatar-policy.ts
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const LOCAL_AVATAR_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg"
]);
const AVATAR_MIME_BY_EXT = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff"
};
const AVATAR_DATA_RE = /^data:/i;
const AVATAR_IMAGE_DATA_RE = /^data:image\//i;
const AVATAR_HTTP_RE = /^https?:\/\//i;
const AVATAR_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;
const AVATAR_PATH_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico)$/i;
function resolveAvatarMime(filePath) {
	return AVATAR_MIME_BY_EXT[normalizeLowercaseStringOrEmpty(path.extname(filePath))] ?? "application/octet-stream";
}
function isAvatarDataUrl(value) {
	return AVATAR_DATA_RE.test(value);
}
function isAvatarImageDataUrl(value) {
	return AVATAR_IMAGE_DATA_RE.test(value);
}
function isAvatarHttpUrl(value) {
	return AVATAR_HTTP_RE.test(value);
}
function hasAvatarUriScheme(value) {
	return AVATAR_SCHEME_RE.test(value);
}
function isWindowsAbsolutePath(value) {
	return WINDOWS_ABS_RE.test(value);
}
function isWorkspaceRelativeAvatarPath(value) {
	if (!value) return false;
	if (value.startsWith("~")) return false;
	if (hasAvatarUriScheme(value) && !isWindowsAbsolutePath(value)) return false;
	return true;
}
function isPathWithinRoot(rootDir, targetPath) {
	const relative = path.relative(rootDir, targetPath);
	if (relative === "") return true;
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}
function looksLikeAvatarPath(value) {
	if (/[\\/]/.test(value)) return true;
	return AVATAR_PATH_EXT_RE.test(value);
}
function isSupportedLocalAvatarExtension(filePath) {
	const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
	return LOCAL_AVATAR_EXTENSIONS.has(ext);
}
//#endregion
export { isAvatarImageDataUrl as a, isWindowsAbsolutePath as c, resolveAvatarMime as d, isAvatarHttpUrl as i, isWorkspaceRelativeAvatarPath as l, hasAvatarUriScheme as n, isPathWithinRoot as o, isAvatarDataUrl as r, isSupportedLocalAvatarExtension as s, AVATAR_MAX_BYTES as t, looksLikeAvatarPath as u };
