//#region node_modules/@openclaw/fs-safe/dist/async-lock.js
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
export { createAsyncLock as t };
