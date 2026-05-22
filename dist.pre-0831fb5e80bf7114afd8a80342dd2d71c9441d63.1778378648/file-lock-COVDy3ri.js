import "./fs-safe-defaults-PMwkNo6J.js";
import { i as resetFileLockManagerForTest, r as drainFileLockManagerForTest, t as acquireFileLock$1 } from "./file-lock-DuSK-TA1.js";
import { n as isPidAlive } from "./pid-alive-C4eJNZe0.js";
//#region src/plugin-sdk/file-lock.ts
const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
const FILE_LOCK_MANAGER_KEY = "openclaw.plugin-sdk.file-lock";
function readLockPayload(value) {
	if (!value) return null;
	return {
		pid: typeof value.pid === "number" ? value.pid : void 0,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : void 0
	};
}
async function shouldReclaimPluginLock(params) {
	const payload = readLockPayload(params.payload);
	if (payload?.pid && !isPidAlive(payload.pid)) return true;
	if (payload?.createdAt) {
		const createdAt = Date.parse(payload.createdAt);
		return !Number.isFinite(createdAt) || params.nowMs - createdAt > params.staleMs;
	}
	return true;
}
function normalizeTimeoutError(err) {
	if (err.code === "file_lock_timeout") throw Object.assign(new Error(err.message), {
		code: FILE_LOCK_TIMEOUT_ERROR_CODE,
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
			allowReentrant: true,
			payload: () => ({
				pid: process.pid,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			}),
			shouldReclaim: shouldReclaimPluginLock
		});
		return {
			lockPath: lock.lockPath,
			release: lock.release
		};
	} catch (err) {
		return normalizeTimeoutError(err);
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
export { withFileLock as a, resetFileLockStateForTest as i, acquireFileLock as n, drainFileLockStateForTest as r, FILE_LOCK_TIMEOUT_ERROR_CODE as t };
