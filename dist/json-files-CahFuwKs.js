import "./fs-safe-defaults-azXCfv92.js";
import { i as openRootFileSync } from "./root-file-CqMcFM3J.js";
import { i as readRegularFileSync, r as readRegularFile } from "./regular-file-6GdZVPgG.js";
import { n as replaceFileAtomic$1, r as replaceFileAtomic } from "./replace-file-VPhXrtU-.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
//#region node_modules/@openclaw/fs-safe/dist/text-atomic.js
async function writeTextAtomic$1(filePath, content, options) {
	const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
	const durable = options?.durable ?? true;
	await replaceFileAtomic({
		filePath,
		content: payload,
		mode: options?.mode ?? 384,
		dirMode: options?.dirMode ?? 511 & ~process.umask(),
		copyFallbackOnPermissionError: true,
		syncTempFile: durable,
		syncParentDir: durable
	});
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/json.js
const JSON_FILE_MODE = 384;
const JSON_DIR_MODE = 448;
const SUPPORTS_SYNC_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fs.constants;
function getErrorCode(err) {
	return err instanceof Error ? err.code : void 0;
}
function trySetSecureMode(pathname) {
	let fd;
	try {
		fd = fs.openSync(pathname, fs.constants.O_RDONLY | (SUPPORTS_SYNC_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0));
		fs.fchmodSync(fd, JSON_FILE_MODE);
	} catch {} finally {
		if (fd !== void 0) try {
			fs.closeSync(fd);
		} catch {}
	}
}
function trySyncDirectory(pathname) {
	let fd;
	try {
		fd = fs.openSync(path.dirname(pathname), "r");
		fs.fsyncSync(fd);
	} catch {} finally {
		if (fd !== void 0) try {
			fs.closeSync(fd);
		} catch {}
	}
}
function renameJsonFileWithFallback(tmpPath, pathname) {
	try {
		fs.renameSync(tmpPath, pathname);
		return;
	} catch (error) {
		const code = error.code;
		if (code === "EPERM" || code === "EEXIST") {
			if ((() => {
				try {
					return fs.lstatSync(pathname);
				} catch (lstatError) {
					if (lstatError.code === "ENOENT") return null;
					throw lstatError;
				}
			})()?.isSymbolicLink()) {
				fs.rmSync(pathname, { force: true });
				fs.renameSync(tmpPath, pathname);
				return;
			}
			fs.rmSync(pathname, { force: true });
			fs.renameSync(tmpPath, pathname);
			return;
		}
		throw error;
	}
}
function writeTempJsonFile(pathname, payload) {
	const fd = fs.openSync(pathname, "wx", JSON_FILE_MODE);
	try {
		fs.writeFileSync(fd, payload, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}
function tryReadJsonSync(pathname) {
	try {
		const raw = readRegularFileSync({ filePath: pathname }).buffer.toString("utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
function writeJsonSync(pathname, data) {
	const targetPath = pathname;
	const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
	const payload = `${JSON.stringify(data, null, 2)}\n`;
	fs.mkdirSync(path.dirname(targetPath), {
		recursive: true,
		mode: JSON_DIR_MODE
	});
	try {
		writeTempJsonFile(tmpPath, payload);
		trySetSecureMode(tmpPath);
		renameJsonFileWithFallback(tmpPath, targetPath);
		trySetSecureMode(targetPath);
		trySyncDirectory(targetPath);
	} finally {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {}
	}
}
var JsonFileReadError = class extends Error {
	filePath;
	reason;
	constructor(filePath, reason, cause) {
		super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
		this.name = "JsonFileReadError";
		this.filePath = filePath;
		this.reason = reason;
	}
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveInvalidMessage(invalidMessage, relativePath) {
	if (typeof invalidMessage === "function") return invalidMessage(relativePath);
	return invalidMessage ?? `${relativePath} has an unexpected shape`;
}
function readRootStructuredFileSync(options) {
	const opened = openRootFileSync({
		absolutePath: path.resolve(options.rootDir, options.relativePath),
		rootPath: options.rootDir,
		...options.rootRealPath !== void 0 ? { rootRealPath: options.rootRealPath } : {},
		boundaryLabel: options.boundaryLabel,
		rejectHardlinks: options.rejectHardlinks,
		maxBytes: options.maxBytes,
		allowedType: "file"
	});
	if (!opened.ok) return {
		ok: false,
		reason: "open",
		failure: opened
	};
	try {
		const parsed = options.parse(fs.readFileSync(opened.fd, "utf8"));
		if (options.validate && !options.validate(parsed)) return {
			ok: false,
			reason: "invalid",
			error: resolveInvalidMessage(options.invalidMessage, options.relativePath)
		};
		return {
			ok: true,
			value: parsed,
			stat: opened.stat,
			path: opened.path,
			rootRealPath: opened.rootRealPath
		};
	} catch (error) {
		return {
			ok: false,
			reason: "parse",
			error: `failed to parse ${options.relativePath}: ${String(error)}`
		};
	} finally {
		fs.closeSync(opened.fd);
	}
}
function readRootJsonSync(options) {
	return readRootStructuredFileSync({
		...options,
		parse: (raw) => JSON.parse(raw)
	});
}
function readRootJsonObjectSync(options) {
	return readRootStructuredFileSync({
		...options,
		parse: (raw) => JSON.parse(raw),
		validate: isRecord,
		invalidMessage: (relativePath) => `${relativePath} must contain a JSON object`
	});
}
async function tryReadJson(filePath) {
	try {
		const raw = (await readRegularFile({ filePath })).buffer.toString("utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function readJson(filePath) {
	let raw;
	try {
		raw = (await readRegularFile({ filePath })).buffer.toString("utf8");
	} catch (err) {
		throw new JsonFileReadError(filePath, "read", err);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new JsonFileReadError(filePath, "parse", err);
	}
}
async function readJsonIfExists(filePath) {
	let raw;
	try {
		raw = (await readRegularFile({ filePath })).buffer.toString("utf8");
	} catch (err) {
		if (getErrorCode(err) === "ENOENT") return null;
		throw new JsonFileReadError(filePath, "read", err);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new JsonFileReadError(filePath, "parse", err);
	}
}
function readJsonSync(filePath) {
	let raw;
	try {
		raw = readRegularFileSync({ filePath }).buffer.toString("utf8");
	} catch (err) {
		throw new JsonFileReadError(filePath, "read", err);
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new JsonFileReadError(filePath, "parse", err);
	}
}
async function writeJson(filePath, value, options) {
	await writeTextAtomic$1(filePath, JSON.stringify(value, null, 2), {
		mode: options?.mode,
		dirMode: options?.dirMode,
		trailingNewline: options?.trailingNewline,
		durable: options?.durable
	});
}
//#endregion
//#region src/infra/json-files.ts
async function writeTextAtomic(filePath, content, options) {
	await replaceFileAtomic$1({
		filePath,
		content: options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content,
		mode: options?.mode ?? 384,
		dirMode: options?.dirMode ?? 511 & ~process.umask(),
		copyFallbackOnPermissionError: true,
		syncTempFile: options?.durable !== false,
		syncParentDir: options?.durable !== false
	});
}
//#endregion
export { readJsonSync as a, readRootStructuredFileSync as c, writeJson as d, writeJsonSync as f, readJsonIfExists as i, tryReadJson as l, JsonFileReadError as n, readRootJsonObjectSync as o, readJson as r, readRootJsonSync as s, writeTextAtomic as t, tryReadJsonSync as u };
