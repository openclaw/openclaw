import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { URL, fileURLToPath } from "node:url";
import path from "node:path";
//#region src/infra/local-file-access.ts
const ENCODED_FILE_URL_SEPARATOR_RE = /%(?:2f|5c)/i;
function isLocalFileUrlHost(hostname) {
	const normalized = normalizeLowercaseStringOrEmpty(hostname);
	return normalized === "" || normalized === "localhost";
}
function hasEncodedFileUrlSeparator(pathname) {
	return ENCODED_FILE_URL_SEPARATOR_RE.test(pathname);
}
function isWindowsNetworkPath(filePath) {
	if (process.platform !== "win32") return false;
	const normalized = filePath.replace(/\//g, "\\");
	return normalized.startsWith("\\\\?\\UNC\\") || normalized.startsWith("\\\\");
}
function assertNoWindowsNetworkPath(filePath, label = "Path") {
	if (isWindowsNetworkPath(filePath)) throw new Error(`${label} cannot use Windows network paths: ${filePath}`);
}
function safeFileURLToPath(fileUrl) {
	let parsed;
	try {
		parsed = new URL(fileUrl);
	} catch {
		throw new Error(`Invalid file:// URL: ${fileUrl}`);
	}
	if (parsed.protocol !== "file:") throw new Error(`Invalid file:// URL: ${fileUrl}`);
	if (!isLocalFileUrlHost(parsed.hostname)) throw new Error(`file:// URLs with remote hosts are not allowed: ${fileUrl}`);
	if (hasEncodedFileUrlSeparator(parsed.pathname)) throw new Error(`file:// URLs cannot encode path separators: ${fileUrl}`);
	const filePath = fileURLToPath(parsed);
	assertNoWindowsNetworkPath(filePath, "Local file URL");
	return filePath;
}
function trySafeFileURLToPath(fileUrl) {
	try {
		return safeFileURLToPath(fileUrl);
	} catch {
		return;
	}
}
function basenameFromMediaSource(source) {
	if (!source) return;
	if (source.startsWith("file://")) {
		const filePath = trySafeFileURLToPath(source);
		return filePath ? path.basename(filePath) || void 0 : void 0;
	}
	if (/^https?:\/\//i.test(source)) try {
		return path.basename(new URL(source).pathname) || void 0;
	} catch {
		return;
	}
	return path.basename(source) || void 0;
}
//#endregion
export { safeFileURLToPath as a, isWindowsNetworkPath as i, basenameFromMediaSource as n, trySafeFileURLToPath as o, hasEncodedFileUrlSeparator as r, assertNoWindowsNetworkPath as t };
