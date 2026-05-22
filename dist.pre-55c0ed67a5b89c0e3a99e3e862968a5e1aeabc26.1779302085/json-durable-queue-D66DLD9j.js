import { t as sameFileIdentity } from "./file-identity-BKNyWMFA.js";
import { t as stringifyJsonDocument } from "./json-stringify-DYDqVIo7.js";
import { n as assertSafePathSegment } from "./safe-path-segment-km_q4Jns.js";
import { r as replaceFileAtomic } from "./replace-file-Dr-OmBmA.js";
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
	const roots = await queueValidationRoots(params.queueDir, params.failedDir);
	await ensureJsonDurableQueueDir(params.queueDir, roots.queueRoot);
	await ensureJsonDurableQueueDir(params.failedDir, roots.failedRoot);
}
async function ensureJsonDurableQueueDir(dir, validationRoot) {
	const root = validationRoot ? validationRoot : queueValidationRoot(dir);
	await assertNoSymlinkDirectorySegments(root, dir, true);
	await fs.promises.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	await assertNoSymlinkDirectorySegments(root, dir, false);
	await chmodQueueDirectory(dir);
}
async function assertJsonDurableQueueDir(dir, validationRoot) {
	await assertNoSymlinkDirectorySegments(validationRoot ? validationRoot : queueValidationRoot(dir), dir, false);
}
function commonPathAncestor(paths) {
	const resolved = paths.map((entry) => path.resolve(entry));
	const root = path.parse(resolved[0] ?? process.cwd()).root;
	const parts = resolved.map((entry) => path.relative(root, entry).split(path.sep));
	const common = [];
	for (let index = 0; parts.every((part) => index < part.length); index++) {
		const segment = parts[0]?.[index];
		if (!segment || !parts.every((part) => part[index] === segment)) break;
		common.push(segment);
	}
	return path.join(root, ...common);
}
function samePathRoot(paths) {
	const roots = paths.map((entry) => path.parse(path.resolve(entry)).root);
	const first = process.platform === "win32" ? roots[0]?.toLowerCase() : roots[0];
	return roots.every((root) => (process.platform === "win32" ? root.toLowerCase() : root) === first);
}
async function queueValidationRoots(queueDir, failedDir) {
	if (samePathRoot([queueDir, failedDir])) {
		const root = queueValidationRoot(commonPathAncestor([queueDir, failedDir]));
		return {
			failedRoot: root,
			queueRoot: root
		};
	}
	return {
		failedRoot: queueValidationRoot(failedDir),
		queueRoot: queueValidationRoot(queueDir)
	};
}
function queueValidationRoot(dir) {
	return {
		path: path.parse(path.resolve(dir)).root,
		allowSymlinkBase: process.platform === "darwin"
	};
}
async function isDarwinSystemAlias(dir, stat) {
	if (process.platform !== "darwin" || !stat.isSymbolicLink()) return false;
	const resolved = path.resolve(dir);
	if (resolved !== "/tmp" && resolved !== "/var") return false;
	return await fs.promises.realpath(resolved).then((realPath) => realPath === `/private${resolved}`, () => false);
}
async function assertNoSymlinkDirectorySegments(validationRoot, dir, allowMissing) {
	let base = path.resolve(validationRoot.path);
	let target = path.resolve(dir);
	let current = base;
	let baseStat = await fs.promises.lstat(base);
	if (baseStat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
		const relative = path.relative(base, target);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`durable queue path is not a directory: ${dir}`);
		base = await fs.promises.realpath(base);
		target = path.join(base, ...relative.split(path.sep).filter(Boolean));
		current = base;
		baseStat = await fs.promises.lstat(base);
	}
	if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error(`durable queue path is not a directory: ${dir}`);
	const segments = path.relative(base, target).split(path.sep).filter(Boolean);
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === void 0) continue;
		current = path.join(current, segment);
		let stat;
		try {
			stat = await fs.promises.lstat(current);
		} catch (error) {
			if (allowMissing && error.code === "ENOENT") return;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			if (stat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
				if (await isDarwinSystemAlias(current, stat)) {
					current = await fs.promises.realpath(current);
					continue;
				}
			}
			throw new Error(`durable queue path is not a directory: ${dir}`);
		}
	}
}
async function chmodQueueDirectory(dir) {
	const noFollow = typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32" ? fs.constants.O_NOFOLLOW : 0;
	const directoryFlag = typeof fs.constants.O_DIRECTORY === "number" && process.platform !== "win32" ? fs.constants.O_DIRECTORY : 0;
	if (noFollow || directoryFlag) {
		let handle;
		try {
			handle = await fs.promises.open(dir, fs.constants.O_RDONLY | noFollow | directoryFlag);
			if (!(await handle.stat()).isDirectory()) throw new Error(`durable queue path is not a directory: ${dir}`);
			try {
				await handle.chmod(448);
			} catch {}
			return;
		} finally {
			try {
				await handle?.close();
			} catch {}
		}
	}
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`durable queue path is not a directory: ${dir}`);
	try {
		await fs.promises.chmod(dir, 448);
	} catch {}
}
async function writeJsonDurableQueueEntry(params) {
	await replaceFileAtomic({
		filePath: params.filePath,
		content: stringifyJsonDocument(params.entry, null, 2),
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
	const roots = await queueValidationRoots(params.queueDir, params.failedDir);
	await assertJsonDurableQueueDir(params.queueDir, roots.queueRoot);
	await ensureJsonDurableQueueDir(params.failedDir, roots.failedRoot);
	await fs.promises.rename(path.join(params.queueDir, `${params.id}.json`), path.join(params.failedDir, `${params.id}.json`));
}
//#endregion
export { loadPendingJsonDurableQueueEntries as a, resolveJsonDurableQueueEntryPaths as c, loadJsonDurableQueueEntry as i, writeJsonDurableQueueEntry as l, ensureJsonDurableQueueDirs as n, moveJsonDurableQueueEntryToFailed as o, jsonDurableQueueEntryExists as r, readJsonDurableQueueEntry as s, ackJsonDurableQueueEntry as t };
