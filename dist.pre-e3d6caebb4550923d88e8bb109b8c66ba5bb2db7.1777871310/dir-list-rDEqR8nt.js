import { a as mimeFromExtension } from "./mime-DCpjwH2C.js";
import path from "node:path";
import fs from "node:fs/promises";
const DIR_LIST_HARD_MAX_ENTRIES = 5e3;
function clampMaxEntries(input) {
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return 200;
	return Math.min(Math.floor(input), DIR_LIST_HARD_MAX_ENTRIES);
}
function classifyFsError(err) {
	const code = err?.code;
	if (code === "ENOENT") return "NOT_FOUND";
	if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
	return "READ_ERROR";
}
async function handleDirList(params) {
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
	const maxEntries = clampMaxEntries(params.maxEntries);
	const offset = typeof params.pageToken === "string" && params.pageToken.length > 0 ? Math.max(0, Number.parseInt(params.pageToken, 10) || 0) : 0;
	const followSymlinks = params.followSymlinks === true;
	let canonical;
	try {
		canonical = await fs.realpath(requestedPath);
	} catch (err) {
		const code = classifyFsError(err);
		return {
			ok: false,
			code,
			message: code === "NOT_FOUND" ? "path not found" : `realpath failed: ${String(err)}`
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
	if (!stats.isDirectory()) return {
		ok: false,
		code: "IS_FILE",
		message: "path is not a directory",
		canonicalPath: canonical
	};
	let names;
	try {
		names = await fs.readdir(canonical, { encoding: "utf8" });
	} catch (err) {
		return {
			ok: false,
			code: classifyFsError(err),
			message: `readdir failed: ${String(err)}`,
			canonicalPath: canonical
		};
	}
	names.sort((a, b) => a.localeCompare(b));
	const total = names.length;
	const page = names.slice(offset, offset + maxEntries);
	const truncated = offset + maxEntries < total;
	const nextPageToken = truncated ? String(offset + maxEntries) : void 0;
	const entries = [];
	for (const name of page) {
		const entryPath = path.join(canonical, name);
		let isDir = false;
		let size = 0;
		let mtime = 0;
		try {
			const s = await fs.stat(entryPath);
			isDir = s.isDirectory();
			size = isDir ? 0 : s.size;
			mtime = s.mtimeMs;
		} catch {}
		entries.push({
			name,
			path: entryPath,
			size,
			mimeType: isDir ? "inode/directory" : mimeFromExtension(name),
			isDir,
			mtime
		});
	}
	return {
		ok: true,
		path: canonical,
		entries,
		nextPageToken,
		truncated
	};
}
//#endregion
export { handleDirList };
