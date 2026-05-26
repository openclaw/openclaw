//#region extensions/matrix/src/matrix/async-lock.ts
function createAsyncLock() {
	let lock = Promise.resolve();
	return async function withLock(fn) {
		const previous = lock;
		let release;
		lock = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release?.();
		}
	};
}
//#endregion
export { createAsyncLock as t };
