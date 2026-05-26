import { n as getFsSafeLockConfig, t as createSidecarLockManager } from "./sidecar-lock-Bv7C32CP.js";
//#region node_modules/@openclaw/fs-safe/dist/file-lock.js
function resolveFileLockManagerKey(targetPath, managerKey) {
	return managerKey ?? `fs-safe.file-lock:${targetPath}`;
}
function withLockDefaults(options) {
	const defaults = getFsSafeLockConfig();
	return {
		...options,
		retry: options.retry ?? defaults.retry,
		staleMs: options.staleMs ?? defaults.staleMs ?? 3e4,
		staleRecovery: options.staleRecovery ?? defaults.staleRecovery,
		timeoutMs: options.timeoutMs ?? defaults.timeoutMs
	};
}
async function acquireFileLock(targetPath, options) {
	return await createFileLockManager(resolveFileLockManagerKey(targetPath, options.managerKey)).acquire(targetPath, options);
}
function createFileLockManager(key) {
	const manager = createSidecarLockManager(key);
	return {
		acquire: async (targetPath, options) => {
			const { managerKey: _managerKey, ...acquireOptions } = options;
			return await manager.acquire({
				...withLockDefaults(acquireOptions),
				targetPath
			});
		},
		withLock: async (targetPath, options, fn) => {
			const { managerKey: _managerKey, ...acquireOptions } = options;
			return await manager.withLock({
				...withLockDefaults(acquireOptions),
				targetPath
			}, fn);
		},
		drain: manager.drain,
		reset: manager.reset,
		heldEntries: manager.heldEntries
	};
}
async function drainFileLockManagerForTest(targetPath, managerKey) {
	await createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).drain();
}
function resetFileLockManagerForTest(targetPath, managerKey) {
	createFileLockManager(resolveFileLockManagerKey(targetPath, managerKey)).reset();
}
//#endregion
export { resetFileLockManagerForTest as i, createFileLockManager as n, drainFileLockManagerForTest as r, acquireFileLock as t };
