import "./fs-safe-defaults-B7hUN42l.js";
import { i as resetFileLockManagerForTest, r as drainFileLockManagerForTest, t as acquireFileLock$1 } from "./file-lock-D6zEe-ZP.js";
import { r as isPidDefinitelyDead } from "./pid-alive-C0-jAJSa.js";
//#region src/infra/stale-lock-file.ts
function readLockFileOwnerPayload(payload) {
	if (!payload) return null;
	return {
		pid: typeof payload.pid === "number" ? payload.pid : void 0,
		createdAt: typeof payload.createdAt === "string" ? payload.createdAt : void 0
	};
}
function shouldRemoveDeadOwnerOrExpiredLock(params) {
	const payload = readLockFileOwnerPayload(params.payload);
	if (payload?.pid) return (params.isPidDefinitelyDead ?? isPidDefinitelyDead)(payload.pid);
	if (payload?.createdAt) {
		const createdAt = Date.parse(payload.createdAt);
		return !Number.isFinite(createdAt) || (params.nowMs ?? Date.now()) - createdAt > params.staleMs;
	}
	return false;
}
//#endregion
//#region src/plugin-sdk/file-lock.ts
const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
const FILE_LOCK_STALE_ERROR_CODE = "file_lock_stale";
const FILE_LOCK_MANAGER_KEY = "openclaw.plugin-sdk.file-lock";
async function shouldReclaimPluginLock(params) {
	return shouldRemoveDeadOwnerOrExpiredLock({
		payload: params.payload,
		staleMs: params.staleMs,
		nowMs: params.nowMs
	});
}
function normalizeLockError(err) {
	if (err.code === "file_lock_timeout") throw Object.assign(new Error(err.message), {
		code: FILE_LOCK_TIMEOUT_ERROR_CODE,
		lockPath: err.lockPath ?? ""
	});
	if (err.code === "file_lock_stale") throw Object.assign(new Error(err.message), {
		code: FILE_LOCK_STALE_ERROR_CODE,
		lockPath: err.lockPath ?? ""
	});
	throw err;
}
function resetFileLockStateForTest() {
	resetFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}
async function drainFileLockStateForTest() {
	await drainFileLockManagerForTest(FILE_LOCK_MANAGER_KEY, FILE_LOCK_MANAGER_KEY);
}
/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
async function acquireFileLock(filePath, options) {
	try {
		const lock = await acquireFileLock$1(filePath, {
			managerKey: FILE_LOCK_MANAGER_KEY,
			staleMs: options.stale,
			retry: options.retries,
			staleRecovery: "remove-if-unchanged",
			allowReentrant: true,
			payload: () => ({
				pid: process.pid,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			}),
			shouldReclaim: shouldReclaimPluginLock,
			shouldRemoveStaleLock: (snapshot) => shouldRemoveDeadOwnerOrExpiredLock({
				payload: snapshot.payload,
				staleMs: options.stale
			})
		});
		return {
			lockPath: lock.lockPath,
			release: lock.release
		};
	} catch (err) {
		return normalizeLockError(err);
	}
}
/** Run an async callback while holding a file lock, always releasing the lock afterward. */
async function withFileLock(filePath, options, fn) {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
//#endregion
export { resetFileLockStateForTest as a, drainFileLockStateForTest as i, FILE_LOCK_TIMEOUT_ERROR_CODE as n, withFileLock as o, acquireFileLock as r, FILE_LOCK_STALE_ERROR_CODE as t };
