import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
//#region extensions/file-transfer/src/node-host/dir-fetch.ts
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
function clampMaxBytes(input) {
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return DIR_FETCH_DEFAULT_MAX_BYTES;
	return Math.min(Math.floor(input), DIR_FETCH_HARD_MAX_BYTES);
}
function classifyFsError(err) {
	if (err?.code === "ENOENT") return "NOT_FOUND";
	return "READ_ERROR";
}
async function preflightDu(dirPath, maxBytes) {
	const heuristicKb = Math.ceil(maxBytes * 4 / 1024);
	return new Promise((resolve) => {
		const du = spawn("du", ["-sk", dirPath], { stdio: [
			"ignore",
			"pipe",
			"ignore"
		] });
		let output = "";
		du.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		du.on("close", (code) => {
			if (code !== 0) {
				resolve(true);
				return;
			}
			const match = /^(\d+)/.exec(output.trim());
			if (!match) {
				resolve(true);
				return;
			}
			resolve(Number.parseInt(match[1], 10) <= heuristicKb);
		});
		du.on("error", () => {
			resolve(true);
		});
	});
}
async function listTarEntries(tarBuffer) {
	return new Promise((resolve) => {
		const child = spawn("tar", ["-tzf", "-"], { stdio: [
			"pipe",
			"pipe",
			"ignore"
		] });
		let stdoutBuf = "";
		let aborted = false;
		const watchdog = setTimeout(() => {
			aborted = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve([]);
		}, 1e4);
		child.stdout.on("data", (chunk) => {
			stdoutBuf += chunk.toString();
			if (stdoutBuf.length > 32 * 1024 * 1024) {
				aborted = true;
				try {
					child.kill("SIGKILL");
				} catch {}
				clearTimeout(watchdog);
				resolve([]);
			}
		});
		child.on("close", (code) => {
			clearTimeout(watchdog);
			if (aborted) return;
			if (code !== 0) {
				resolve([]);
				return;
			}
			resolve(stdoutBuf.split("\n").map((line) => line.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "")).filter((line) => line.length > 0));
		});
		child.on("error", () => {
			clearTimeout(watchdog);
			if (!aborted) resolve([]);
		});
		child.stdin.end(tarBuffer);
	});
}
async function listTreeEntries(root, maxEntries) {
	const results = [];
	async function visit(dir) {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).replace(/\\/gu, "/");
			results.push(rel);
			if (results.length > maxEntries) return false;
			if (entry.isDirectory()) {
				if (!await visit(abs)) return false;
			}
		}
		return true;
	}
	return await visit(root) ? results : "TOO_MANY";
}
async function handleDirFetch(params) {
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
	params.includeDotfiles;
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
			message: code === "NOT_FOUND" ? "directory not found" : `realpath failed: ${String(err)}`
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
	if (preflightOnly) try {
		const entries = await listTreeEntries(canonical, 5e3);
		if (entries === "TOO_MANY") return {
			ok: false,
			code: "TREE_TOO_LARGE",
			message: "directory tree exceeds 5000 entries during preflight",
			canonicalPath: canonical
		};
		return {
			ok: true,
			path: canonical,
			tarBase64: "",
			tarBytes: 0,
			sha256: "",
			fileCount: entries.length,
			entries,
			preflightOnly: true
		};
	} catch (err) {
		return {
			ok: false,
			code: classifyFsError(err),
			message: `preflight readdir failed: ${String(err)}`,
			canonicalPath: canonical
		};
	}
	if (!await preflightDu(canonical, maxBytes)) return {
		ok: false,
		code: "TREE_TOO_LARGE",
		message: `directory tree exceeds estimated size limit (${maxBytes} bytes raw)`,
		canonicalPath: canonical
	};
	const tarArgs = [
		"-czf",
		"-",
		"-C",
		canonical,
		"."
	];
	const TAR_HARD_TIMEOUT_MS = 6e4;
	const tarBuffer = await new Promise((resolve) => {
		const child = spawn(process.platform !== "win32" ? "/usr/bin/tar" : "tar", tarArgs, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const chunks = [];
		let totalBytes = 0;
		let aborted = false;
		const watchdog = setTimeout(() => {
			if (aborted) return;
			aborted = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve("TIMEOUT");
		}, TAR_HARD_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			if (aborted) return;
			totalBytes += chunk.byteLength;
			if (totalBytes > maxBytes) {
				aborted = true;
				clearTimeout(watchdog);
				child.kill("SIGTERM");
				resolve("TOO_LARGE");
				return;
			}
			chunks.push(chunk);
		});
		child.on("close", (code) => {
			clearTimeout(watchdog);
			if (aborted) return;
			if (code !== 0) {
				resolve("ERROR");
				return;
			}
			resolve(Buffer.concat(chunks));
		});
		child.on("error", () => {
			clearTimeout(watchdog);
			if (!aborted) resolve("ERROR");
		});
	});
	if (tarBuffer === "TOO_LARGE") return {
		ok: false,
		code: "TREE_TOO_LARGE",
		message: `tarball exceeded ${maxBytes} byte limit mid-stream`,
		canonicalPath: canonical
	};
	if (tarBuffer === "TIMEOUT") return {
		ok: false,
		code: "READ_ERROR",
		message: "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
		canonicalPath: canonical
	};
	if (tarBuffer === "ERROR") return {
		ok: false,
		code: "READ_ERROR",
		message: "tar command failed",
		canonicalPath: canonical
	};
	const sha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
	const tarBase64 = tarBuffer.toString("base64");
	const tarBytes = tarBuffer.byteLength;
	const entries = await listTarEntries(tarBuffer);
	return {
		ok: true,
		path: canonical,
		tarBase64,
		tarBytes,
		sha256,
		fileCount: entries.length,
		entries
	};
}
//#endregion
export { handleDirFetch };
