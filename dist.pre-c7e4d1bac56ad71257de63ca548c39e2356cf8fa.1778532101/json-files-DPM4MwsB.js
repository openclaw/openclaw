import { readFileSync } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region src/infra/json-files.ts
function getErrorCode(err) {
	return err instanceof Error ? err.code : void 0;
}
var JsonFileReadError = class extends Error {
	constructor(filePath, reason, cause) {
		super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
		this.name = "JsonFileReadError";
		this.filePath = filePath;
		this.reason = reason;
	}
};
async function replaceFileWithWindowsFallback(tempPath, filePath, mode) {
	try {
		await fs$1.rename(tempPath, filePath);
		return;
	} catch (err) {
		const code = getErrorCode(err);
		if (process.platform !== "win32" || code !== "EPERM" && code !== "EEXIST") throw err;
	}
	if ((await fs$1.lstat(filePath).catch(() => null))?.isSymbolicLink()) {
		await fs$1.rm(filePath, { force: true });
		await fs$1.rename(tempPath, filePath);
		return;
	}
	await fs$1.copyFile(tempPath, filePath);
	try {
		await fs$1.chmod(filePath, mode);
	} catch {}
	await fs$1.rm(tempPath, { force: true }).catch(() => void 0);
}
async function readJsonFile(filePath) {
	try {
		const raw = await fs$1.readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function readDurableJsonFile(filePath) {
	let raw;
	try {
		raw = await fs$1.readFile(filePath, "utf8");
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
function readJsonFileSync(filePath) {
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeJsonAtomic(filePath, value, options) {
	await writeTextAtomic(filePath, JSON.stringify(value, null, 2), {
		mode: options?.mode,
		ensureDirMode: options?.ensureDirMode,
		appendTrailingNewline: options?.trailingNewline
	});
}
async function writeTextAtomic(filePath, content, options) {
	const mode = options?.mode ?? 384;
	const payload = options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
	const mkdirOptions = { recursive: true };
	if (typeof options?.ensureDirMode === "number") mkdirOptions.mode = options.ensureDirMode;
	await fs$1.mkdir(path.dirname(filePath), mkdirOptions);
	const parentDir = path.dirname(filePath);
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	try {
		const tmpHandle = await fs$1.open(tmp, "w", mode);
		try {
			await tmpHandle.writeFile(payload, { encoding: "utf8" });
			await tmpHandle.sync();
		} finally {
			await tmpHandle.close().catch(() => void 0);
		}
		try {
			await fs$1.chmod(tmp, mode);
		} catch {}
		await replaceFileWithWindowsFallback(tmp, filePath, mode);
		try {
			const dirHandle = await fs$1.open(parentDir, "r");
			try {
				await dirHandle.sync();
			} finally {
				await dirHandle.close().catch(() => void 0);
			}
		} catch {}
		try {
			await fs$1.chmod(filePath, mode);
		} catch {}
	} finally {
		await fs$1.rm(tmp, { force: true }).catch(() => void 0);
	}
}
function createAsyncLock() {
	let lock = Promise.resolve();
	return async function withLock(fn) {
		const prev = lock;
		let release;
		lock = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release?.();
		}
	};
}
//#endregion
export { readJsonFileSync as a, readJsonFile as i, createAsyncLock as n, writeJsonAtomic as o, readDurableJsonFile as r, writeTextAtomic as s, JsonFileReadError as t };
