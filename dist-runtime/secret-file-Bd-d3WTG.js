import { y as resolveUserPath } from "./utils-Do8MzKyM.js";
import { t as openVerifiedFileSync } from "./safe-open-sync-BmiTH5-j.js";
import fs from "node:fs";
//#region src/infra/secret-file.ts
const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;
function loadSecretFileSync(filePath, label, options = {}) {
	const resolvedPath = resolveUserPath(filePath.trim());
	if (!resolvedPath) {return {
		ok: false,
		message: `${label} file path is empty.`
	};}
	const maxBytes = options.maxBytes ?? 16384;
	let previewStat;
	try {
		previewStat = fs.lstatSync(resolvedPath);
	} catch (error) {
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(error)}`
		};
	}
	if (options.rejectSymlink && previewStat.isSymbolicLink()) {return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} must not be a symlink.`
	};}
	if (!previewStat.isFile()) {return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} must be a regular file.`
	};}
	if (previewStat.size > maxBytes) {return {
		ok: false,
		resolvedPath,
		message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`
	};}
	const opened = openVerifiedFileSync({
		filePath: resolvedPath,
		rejectPathSymlink: options.rejectSymlink,
		maxBytes
	});
	if (!opened.ok) {
		const error = opened.reason === "validation" ? /* @__PURE__ */ new Error("security validation failed") : opened.error;
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`
		};
	}
	try {
		const secret = fs.readFileSync(opened.fd, "utf8").trim();
		if (!secret) {return {
			ok: false,
			resolvedPath,
			message: `${label} file at ${resolvedPath} is empty.`
		};}
		return {
			ok: true,
			secret,
			resolvedPath
		};
	} catch (error) {
		return {
			ok: false,
			resolvedPath,
			error,
			message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function readSecretFileSync(filePath, label, options = {}) {
	const result = loadSecretFileSync(filePath, label, options);
	if (result.ok) {return result.secret;}
	throw new Error(result.message, result.error ? { cause: result.error } : void 0);
}
function tryReadSecretFileSync(filePath, label, options = {}) {
	if (!filePath?.trim()) {return;}
	const result = loadSecretFileSync(filePath, label, options);
	return result.ok ? result.secret : void 0;
}
//#endregion
export { readSecretFileSync as n, tryReadSecretFileSync as r, DEFAULT_SECRET_FILE_MAX_BYTES as t };
