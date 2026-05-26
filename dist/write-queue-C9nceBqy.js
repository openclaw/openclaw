import { m as FsSafeError, r as isNotFoundPathError } from "./path-BlG8lhgR.js";
import { t as sameFileIdentity } from "./file-identity-BKNyWMFA.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region node_modules/@openclaw/fs-safe/dist/directory-guard.js
async function createAsyncDirectoryGuard(dir) {
	const stat = await fs$1.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", "directory component must be a directory");
	return {
		dir,
		realPath: await fs$1.realpath(dir),
		stat
	};
}
async function assertAsyncDirectoryGuard(guard) {
	const stat = await fs$1.lstat(guard.dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", "directory component must be a directory");
	if (!sameFileIdentity(stat, guard.stat) || await fs$1.realpath(guard.dir) !== guard.realPath) throw new FsSafeError("path-mismatch", "directory changed during operation");
}
function createSyncDirectoryGuard(dir) {
	const stat = fs.lstatSync(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", "directory component must be a directory");
	return {
		dir,
		realPath: fs.realpathSync(dir),
		stat
	};
}
function assertSyncDirectoryGuard(guard) {
	const stat = fs.lstatSync(guard.dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", "directory component must be a directory");
	if (!sameFileIdentity(stat, guard.stat) || fs.realpathSync(guard.dir) !== guard.realPath) throw new FsSafeError("path-mismatch", "directory changed during operation");
}
async function createNearestExistingDirectoryGuard(rootReal, targetPath) {
	let current = path.resolve(targetPath);
	const root = path.resolve(rootReal);
	while (current !== root) try {
		return await createAsyncDirectoryGuard(current);
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		current = path.dirname(current);
	}
	return await createAsyncDirectoryGuard(root);
}
function createNearestExistingSyncDirectoryGuard(rootReal, targetPath) {
	let current = path.resolve(targetPath);
	const root = path.resolve(rootReal);
	while (current !== root) try {
		return createSyncDirectoryGuard(current);
	} catch (error) {
		if (!isNotFoundPathError(error)) throw error;
		current = path.dirname(current);
	}
	return createSyncDirectoryGuard(root);
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/guarded-mutation.js
async function withAsyncDirectoryGuards(guards, mutate, options = {}) {
	for (const guard of guards) await assertAsyncDirectoryGuard(guard);
	const result = await mutate();
	if (options.verifyAfter !== false) try {
		for (const guard of guards) await assertAsyncDirectoryGuard(guard);
	} catch (error) {
		if (options.onPostGuardFailure) try {
			await options.onPostGuardFailure(result, error);
		} catch {}
		throw error;
	}
	return result;
}
function withSyncDirectoryGuards(guards, mutate, options = {}) {
	for (const guard of guards) assertSyncDirectoryGuard(guard);
	const result = mutate();
	if (options.verifyAfter !== false) for (const guard of guards) assertSyncDirectoryGuard(guard);
	return result;
}
async function guardedRename(params) {
	await withAsyncDirectoryGuards([await createAsyncDirectoryGuard(path.dirname(params.from)), params.targetRoot ? await createNearestExistingDirectoryGuard(params.targetRoot, path.dirname(params.to)) : await createAsyncDirectoryGuard(path.dirname(params.to))], async () => {
		await fs$1.rename(params.from, params.to);
	}, { verifyAfter: params.verifyAfter });
}
function guardedRenameSync(params) {
	withSyncDirectoryGuards([createSyncDirectoryGuard(path.dirname(params.from)), params.targetRoot ? createNearestExistingSyncDirectoryGuard(params.targetRoot, path.dirname(params.to)) : createSyncDirectoryGuard(path.dirname(params.to))], () => fs.renameSync(params.from, params.to), { verifyAfter: params.verifyAfter });
}
async function guardedRm(params) {
	await withAsyncDirectoryGuards([await createAsyncDirectoryGuard(path.dirname(params.target))], async () => {
		await fs$1.rm(params.target, {
			...params.recursive !== void 0 ? { recursive: params.recursive } : {},
			...params.force !== void 0 ? { force: params.force } : {}
		});
	}, { verifyAfter: params.verifyAfter });
}
function guardedRmSync(params) {
	withSyncDirectoryGuards([createSyncDirectoryGuard(path.dirname(params.target))], () => fs.rmSync(params.target, {
		...params.recursive !== void 0 ? { recursive: params.recursive } : {},
		...params.force !== void 0 ? { force: params.force } : {}
	}), { verifyAfter: params.verifyAfter });
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/temp-cleanup.js
const tempCleanupEntries = /* @__PURE__ */ new Map();
let cleanupRegistered = false;
function cleanupRegisteredTempPathsSync() {
	for (const entry of tempCleanupEntries.values()) try {
		fs.rmSync(entry.path, {
			force: true,
			recursive: entry.recursive
		});
	} catch {}
	tempCleanupEntries.clear();
}
function registerTempPathForExit(tempPath, options) {
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		process.once("exit", cleanupRegisteredTempPathsSync);
	}
	tempCleanupEntries.set(tempPath, {
		path: tempPath,
		recursive: options?.recursive === true
	});
	return () => {
		tempCleanupEntries.delete(tempPath);
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/write-queue.js
const writeQueues = /* @__PURE__ */ new Map();
async function serializePathWrite(key, run) {
	const previous = writeQueues.get(key) ?? Promise.resolve();
	const task = (async () => {
		await previous.catch(() => void 0);
		return await run();
	})();
	const done = task.then(() => void 0, () => void 0);
	writeQueues.set(key, done);
	try {
		return await task;
	} finally {
		if (writeQueues.get(key) === done) writeQueues.delete(key);
	}
}
//#endregion
export { guardedRm as a, assertAsyncDirectoryGuard as c, createNearestExistingDirectoryGuard as d, createSyncDirectoryGuard as f, guardedRenameSync as i, assertSyncDirectoryGuard as l, registerTempPathForExit as n, guardedRmSync as o, guardedRename as r, withAsyncDirectoryGuards as s, serializePathWrite as t, createAsyncDirectoryGuard as u };
