import { t as EXTENSION_MIME } from "./mime-O0lhkuSC.js";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/node-host/file-fetch.ts
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
function detectMimeType(filePath) {
	if (process.platform !== "win32") try {
		const result = spawnSync("file", [
			"-b",
			"--mime-type",
			filePath
		], {
			encoding: "utf-8",
			timeout: 2e3
		});
		const stdout = result.stdout?.trim();
		if (result.status === 0 && stdout) return stdout;
	} catch {}
	return EXTENSION_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
function clampMaxBytes(input) {
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return FILE_FETCH_DEFAULT_MAX_BYTES;
	return Math.min(Math.floor(input), FILE_FETCH_HARD_MAX_BYTES);
}
function classifyFsError(err) {
	const code = err?.code;
	if (code === "ENOENT") return "NOT_FOUND";
	if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
	if (code === "EISDIR") return "IS_DIRECTORY";
	return "READ_ERROR";
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
		canonical = await fs.realpath(requestedPath);
	} catch (err) {
		const code = classifyFsError(err);
		return {
			ok: false,
			code,
			message: code === "NOT_FOUND" ? "file not found" : `realpath failed: ${String(err)}`
		};
	}
	if (!followSymlinks && canonical !== requestedPath) return {
		ok: false,
		code: "SYMLINK_REDIRECT",
		message: `path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowReadPaths to the canonical path)`,
		canonicalPath: canonical
	};
	let stats;
	try {
		stats = await fs.stat(canonical);
	} catch (err) {
		return {
			ok: false,
			code: classifyFsError(err),
			message: `stat failed: ${String(err)}`,
			canonicalPath: canonical
		};
	}
	if (stats.isDirectory()) return {
		ok: false,
		code: "IS_DIRECTORY",
		message: "path is a directory",
		canonicalPath: canonical
	};
	if (!stats.isFile()) return {
		ok: false,
		code: "READ_ERROR",
		message: "path is not a regular file",
		canonicalPath: canonical
	};
	if (stats.size > maxBytes) return {
		ok: false,
		code: "FILE_TOO_LARGE",
		message: `file size ${stats.size} exceeds limit ${maxBytes}`,
		canonicalPath: canonical
	};
	if (preflightOnly) return {
		ok: true,
		path: canonical,
		size: stats.size,
		mimeType: "",
		base64: "",
		sha256: "",
		preflightOnly: true
	};
	let buffer;
	try {
		buffer = await fs.readFile(canonical);
	} catch (err) {
		return {
			ok: false,
			code: classifyFsError(err),
			message: `read failed: ${String(err)}`,
			canonicalPath: canonical
		};
	}
	if (buffer.byteLength > maxBytes) return {
		ok: false,
		code: "FILE_TOO_LARGE",
		message: `read ${buffer.byteLength} bytes exceeds limit ${maxBytes}`,
		canonicalPath: canonical
	};
	const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
	const base64 = buffer.toString("base64");
	const mimeType = detectMimeType(canonical);
	return {
		ok: true,
		path: canonical,
		size: buffer.byteLength,
		mimeType,
		base64,
		sha256
	};
}
//#endregion
export { handleFileFetch };
