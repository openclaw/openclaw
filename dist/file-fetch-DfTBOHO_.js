import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { M as resolveAbsolutePathForRead } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { n as detectMime } from "./mime-DppuT-pZ.js";
import "./media-mime-j2Nhr7Df.js";
import "./security-runtime-CcSekjBd.js";
import path from "node:path";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/node-host/file-fetch.ts
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_SNIFF_MAX_BYTES = 8192;
function clampMaxBytes(input) {
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return FILE_FETCH_DEFAULT_MAX_BYTES;
	return Math.min(Math.floor(input), FILE_FETCH_HARD_MAX_BYTES);
}
function classifyFsError(err) {
	if (err instanceof FsSafeError) {
		if (err.code === "not-found") return "NOT_FOUND";
		if (err.code === "symlink") return "SYMLINK_REDIRECT";
		if (err.code === "invalid-path") return "INVALID_PATH";
		if (err.code === "not-file") return "IS_DIRECTORY";
	}
	const code = err?.code;
	if (code === "ENOENT") return "NOT_FOUND";
	if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
	if (code === "EISDIR") return "IS_DIRECTORY";
	return "READ_ERROR";
}
function isLikelyPlainText(buffer) {
	if (buffer.byteLength === 0) return true;
	const sample = buffer.subarray(0, TEXT_SNIFF_MAX_BYTES);
	if (sample.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(sample);
	} catch {
		return false;
	}
	let controlBytes = 0;
	for (const byte of sample) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlBytes += 1;
	return controlBytes / sample.byteLength < .01;
}
async function detectFetchedFileMime(params) {
	const detected = await detectMime(params);
	if (detected) return detected;
	return isLikelyPlainText(params.buffer) ? "text/plain" : "application/octet-stream";
}
async function handleFileFetch(params) {
	const requestedPath = params.path;
	if (typeof requestedPath !== "string" || requestedPath.length === 0) return {
		ok: false,
		code: "INVALID_PATH",
		message: "path required"
	};
	if (requestedPath.includes("\0")) return {
		ok: false,
		code: "INVALID_PATH",
		message: "path contains NUL byte"
	};
	if (!path.isAbsolute(requestedPath)) return {
		ok: false,
		code: "INVALID_PATH",
		message: "path must be absolute"
	};
	const maxBytes = clampMaxBytes(params.maxBytes);
	const followSymlinks = params.followSymlinks === true;
	const preflightOnly = params.preflightOnly === true;
	let canonical;
	try {
		canonical = (await resolveAbsolutePathForRead(requestedPath, { symlinks: followSymlinks ? "follow" : "reject" })).canonicalPath;
	} catch (err) {
		const code = classifyFsError(err);
		const canonicalPath = err instanceof FsSafeError && err.cause && typeof err.cause === "object" && "canonicalPath" in err.cause && typeof err.cause.canonicalPath === "string" ? err.cause.canonicalPath : void 0;
		return {
			ok: false,
			code,
			message: code === "NOT_FOUND" ? "file not found" : code === "SYMLINK_REDIRECT" ? "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowReadPaths to the canonical path)" : `realpath failed: ${String(err)}`,
			...canonicalPath ? { canonicalPath } : {}
		};
	}
	let opened;
	try {
		opened = await (await root(path.dirname(canonical))).open(path.basename(canonical));
	} catch (err) {
		const code = classifyFsError(err);
		return {
			ok: false,
			code,
			message: code === "IS_DIRECTORY" ? "path is a directory" : `open failed: ${String(err)}`,
			canonicalPath: canonical
		};
	}
	try {
		const stats = opened.stat;
		if (stats.size > maxBytes) return {
			ok: false,
			code: "FILE_TOO_LARGE",
			message: `file size ${stats.size} exceeds limit ${maxBytes}`,
			canonicalPath: opened.realPath
		};
		if (preflightOnly) return {
			ok: true,
			path: opened.realPath,
			size: stats.size,
			mimeType: "",
			base64: "",
			sha256: "",
			preflightOnly: true
		};
		const buffer = await opened.handle.readFile();
		if (buffer.byteLength > maxBytes) return {
			ok: false,
			code: "FILE_TOO_LARGE",
			message: `read ${buffer.byteLength} bytes exceeds limit ${maxBytes}`,
			canonicalPath: opened.realPath
		};
		const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
		const base64 = buffer.toString("base64");
		const mimeType = await detectFetchedFileMime({
			buffer,
			filePath: opened.realPath
		});
		return {
			ok: true,
			path: opened.realPath,
			size: buffer.byteLength,
			mimeType,
			base64,
			sha256
		};
	} catch (err) {
		return {
			ok: false,
			code: classifyFsError(err),
			message: `read failed: ${String(err)}`,
			canonicalPath: opened.realPath
		};
	} finally {
		await opened.handle.close().catch(() => void 0);
	}
}
//#endregion
export { handleFileFetch };
