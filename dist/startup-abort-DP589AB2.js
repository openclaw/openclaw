//#region extensions/matrix/src/matrix/startup-abort.ts
function createMatrixStartupAbortError() {
	const error = /* @__PURE__ */ new Error("Matrix startup aborted");
	error.name = "AbortError";
	return error;
}
function throwIfMatrixStartupAborted(abortSignal) {
	if (abortSignal?.aborted === true) throw createMatrixStartupAbortError();
}
function isMatrixStartupAbortError(error) {
	return error instanceof Error && error.name === "AbortError";
}
async function awaitMatrixStartupWithAbort(promise, abortSignal) {
	if (!abortSignal) return await promise;
	if (abortSignal.aborted) throw createMatrixStartupAbortError();
	return await new Promise((resolve, reject) => {
		const onAbort = () => {
			abortSignal.removeEventListener("abort", onAbort);
			reject(createMatrixStartupAbortError());
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			abortSignal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			abortSignal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
//#endregion
export { throwIfMatrixStartupAborted as i, createMatrixStartupAbortError as n, isMatrixStartupAbortError as r, awaitMatrixStartupWithAbort as t };
