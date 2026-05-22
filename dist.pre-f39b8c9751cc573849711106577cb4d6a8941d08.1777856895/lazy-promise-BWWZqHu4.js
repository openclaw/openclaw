//#region src/shared/lazy-promise.ts
function createLazyPromiseLoader(load, options = {}) {
	let promise;
	const createPromise = () => {
		const loaded = Promise.resolve().then(load);
		if (options.cacheRejections !== true) loaded.catch(() => {
			if (promise === loaded) promise = void 0;
		});
		return loaded;
	};
	return {
		async load() {
			promise ??= createPromise();
			return await promise;
		},
		clear() {
			promise = void 0;
		}
	};
}
function createLazyImportLoader(load, options) {
	return createLazyPromiseLoader(load, options);
}
//#endregion
export { createLazyPromiseLoader as n, createLazyImportLoader as t };
