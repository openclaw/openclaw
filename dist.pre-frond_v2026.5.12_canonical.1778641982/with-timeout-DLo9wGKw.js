//#region src/utils/with-timeout.ts
function withTimeout(promise, timeoutMs) {
	if (!timeoutMs || timeoutMs <= 0) return promise;
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
//#endregion
export { withTimeout as t };
