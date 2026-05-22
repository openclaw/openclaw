import { t as sameFileIdentity } from "./file-identity-Cff8f9mS.js";
import { n as assertSafePathSegment } from "./safe-path-segment-L5svCb3X.js";
import { r as replaceFileAtomic } from "./replace-file-CPhhiRlN.js";
import fs from "node:fs";
import path from "node:path";
function getErrnoCode(error) {
	return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}
function assertSafeQueueEntryId(id) {
	assertSafePathSegment(id, { label: "queue entry id" });
}
async function unlinkBestEffort(filePath) {
	await fs.promises.unlink(filePath).catch(() => void 0);
}
async function jsonDurableQueueEntryExists(filePath) {
	try {
		return (await fs.promises.lstat(filePath)).isFile();
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") return false;
		throw error;
	}
}
async function unlinkStaleTmpBestEffort(filePath, now, maxAgeMs) {
	try {
		const stat = await fs.promises.stat(filePath);
		if (stat.isFile() && now - stat.mtimeMs >= maxAgeMs) await unlinkBestEffort(filePath);
	} catch (error) {
		if (getErrnoCode(error) !== "ENOENT") throw error;
	}
}
function resolveJsonDurableQueueEntryPaths(queueDir, id) {
	assertSafeQueueEntryId(id);
	return {
		jsonPath: path.join(queueDir, `${id}.json`),
		deliveredPath: path.join(queueDir, `${id}.delivered`)
	};
}
async function ensureJsonDurableQueueDirs(params) {
	await fs.promises.mkdir(params.queueDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.mkdir(params.failedDir, {
		recursive: true,
		mode: 448
	});
}
async function writeJsonDurableQueueEntry(params) {
	await replaceFileAtomic({
		filePath: params.filePath,
		content: JSON.stringify(params.entry, null, 2),
		mode: 384,
		tempPrefix: params.tempPrefix
	});
}
async function readBoundedUtf8File(params) {
	const initialStat = await fs.promises.lstat(params.filePath);
	if (initialStat.isSymbolicLink() || !initialStat.isFile()) throw new Error("queue entry is not a regular file");
	if (initialStat.size > params.maxBytes) throw new Error(`queue entry exceeds ${params.maxBytes} bytes`);
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32" ? fs.constants.O_NOFOLLOW : 0;
	const handle = await fs.promises.open(params.filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const openedStat = await handle.stat();
		const pathStat = await fs.promises.lstat(params.filePath);
		if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile() || !sameFileIdentity(initialStat, openedStat) || !sameFileIdentity(pathStat, openedStat)) throw new Error("queue entry changed during read");
		const chunks = [];
		const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, params.maxBytes + 1));
		let total = 0;
		while (true) {
			const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
			if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8");
			total += bytesRead;
			if (total > params.maxBytes) throw new Error(`queue entry exceeds ${params.maxBytes} bytes`);
			chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
		}
	} finally {
		await handle.close();
	}
}
async function readJsonDurableQueueEntry(filePath, options = {}) {
	return JSON.parse(await readBoundedUtf8File({
		filePath,
		maxBytes: options.maxBytes ?? 16777216
	}));
}
async function ackJsonDurableQueueEntry(paths) {
	try {
		await fs.promises.rename(paths.jsonPath, paths.deliveredPath);
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") {
			await unlinkBestEffort(paths.deliveredPath);
			return;
		}
		throw error;
	}
	await unlinkBestEffort(paths.deliveredPath);
}
async function loadJsonDurableQueueEntry(params) {
	try {
		if (!(await fs.promises.lstat(params.paths.jsonPath)).isFile()) return null;
		const raw = await readJsonDurableQueueEntry(params.paths.jsonPath, { maxBytes: params.maxBytes });
		const result = params.read ? await params.read(raw, params.paths.jsonPath) : { entry: raw };
		if (result.migrated) await writeJsonDurableQueueEntry({
			filePath: params.paths.jsonPath,
			entry: result.entry,
			tempPrefix: params.tempPrefix
		});
		return result.entry;
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") return null;
		throw error;
	}
}
async function loadPendingJsonDurableQueueEntries(options) {
	let files;
	try {
		files = await fs.promises.readdir(options.queueDir);
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") return [];
		throw error;
	}
	const now = Date.now();
	for (const file of files) if (file.endsWith(".delivered")) await unlinkBestEffort(path.join(options.queueDir, file));
	else if (options.cleanupTmpMaxAgeMs !== void 0 && file.endsWith(".tmp")) await unlinkStaleTmpBestEffort(path.join(options.queueDir, file), now, options.cleanupTmpMaxAgeMs);
	const entries = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const filePath = path.join(options.queueDir, file);
		try {
			if (!(await fs.promises.lstat(filePath)).isFile()) continue;
			const raw = await readJsonDurableQueueEntry(filePath, { maxBytes: options.maxBytes });
			const result = options.read ? await options.read(raw, filePath) : { entry: raw };
			if (result.migrated) await writeJsonDurableQueueEntry({
				filePath,
				entry: result.entry,
				tempPrefix: options.tempPrefix
			});
			entries.push(result.entry);
		} catch {
			continue;
		}
	}
	return entries;
}
async function moveJsonDurableQueueEntryToFailed(params) {
	assertSafeQueueEntryId(params.id);
	await fs.promises.mkdir(params.failedDir, {
		recursive: true,
		mode: 448
	});
	await fs.promises.rename(path.join(params.queueDir, `${params.id}.json`), path.join(params.failedDir, `${params.id}.json`));
}
//#endregion
export { loadPendingJsonDurableQueueEntries as a, resolveJsonDurableQueueEntryPaths as c, loadJsonDurableQueueEntry as i, writeJsonDurableQueueEntry as l, ensureJsonDurableQueueDirs as n, moveJsonDurableQueueEntryToFailed as o, jsonDurableQueueEntryExists as r, readJsonDurableQueueEntry as s, ackJsonDurableQueueEntry as t };
