import { m as FsSafeError } from "./path-BlG8lhgR.js";
import { M as resolveAbsolutePathForRead } from "./fs-safe-CV86zY9G.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import "./security-runtime-CcSekjBd.js";
import { i as mimeFromExtension } from "./mime-CfMm5H5N.js";
import path from "node:path";
import fs from "node:fs/promises";
const DIR_LIST_HARD_MAX_ENTRIES = 5e3;
function clampMaxEntries(input) {
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return 200;
	return Math.min(Math.floor(input), DIR_LIST_HARD_MAX_ENTRIES);
}
function classifyFsError(err) {
	if (err instanceof FsSafeError) {
		if (err.code === "not-found") return "NOT_FOUND";
		if (err.code === "symlink") return "SYMLINK_REDIRECT";
		if (err.code === "invalid-path") return "INVALID_PATH";
	}
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
		canonical = (await resolveAbsolutePathForRead(requestedPath, { symlinks: followSymlinks ? "follow" : "reject" })).canonicalPath;
	} catch (err) {
		const code = classifyFsError(err);
		const canonicalPath = err instanceof FsSafeError && err.cause && typeof err.cause === "object" && "canonicalPath" in err.cause && typeof err.cause.canonicalPath === "string" ? err.cause.canonicalPath : void 0;
		return {
			ok: false,
			code,
			message: code === "NOT_FOUND" ? "path not found" : code === "SYMLINK_REDIRECT" ? "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowReadPaths to the canonical path)" : `realpath failed: ${String(err)}`,
			...canonicalPath ? { canonicalPath } : {}
		};
	}
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
	let listedEntries;
	try {
		listedEntries = await (await root(canonical)).list(".", { withFileTypes: true });
	} catch (err) {
		return {
			ok: false,
			code: classifyFsError(err),
			message: `list failed: ${String(err)}`,
			canonicalPath: canonical
		};
	}
	listedEntries.sort((a, b) => a.name.localeCompare(b.name));
	const total = listedEntries.length;
	const page = listedEntries.slice(offset, offset + maxEntries);
	const truncated = offset + maxEntries < total;
	const nextPageToken = truncated ? String(offset + maxEntries) : void 0;
	const entries = [];
	for (const entry of page) {
		const entryPath = path.join(canonical, entry.name);
		const isDir = entry.isDirectory;
		entries.push({
			name: entry.name,
			path: entryPath,
			size: isDir ? 0 : entry.size,
			mimeType: isDir ? "inode/directory" : mimeFromExtension(entry.name),
			isDir,
			mtime: entry.mtimeMs
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
