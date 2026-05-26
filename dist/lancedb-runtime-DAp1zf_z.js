//#region extensions/memory-lancedb/lancedb-runtime.ts
function buildLoadFailureMessage(error) {
	return [
		"memory-lancedb: bundled @lancedb/lancedb dependency is unavailable.",
		"Install or repair the memory-lancedb plugin package dependencies, then restart OpenClaw.",
		String(error)
	].join(" ");
}
function isUnsupportedNativePlatform(params) {
	return params.platform === "darwin" && params.arch === "x64";
}
function buildUnsupportedNativePlatformMessage(params) {
	return [
		`memory-lancedb: LanceDB runtime is unavailable on ${params.platform}-${params.arch}.`,
		"The bundled @lancedb/lancedb dependency does not publish a native package for this platform.",
		"Disable memory-lancedb or switch to a supported memory backend/platform."
	].join(" ");
}
function createLanceDbRuntimeLoader(overrides = {}) {
	const deps = {
		platform: overrides.platform ?? process.platform,
		arch: overrides.arch ?? process.arch,
		importBundled: overrides.importBundled ?? (() => import("@lancedb/lancedb"))
	};
	let loadPromise = null;
	return { async load(_logger) {
		if (!loadPromise) loadPromise = deps.importBundled().catch((error) => {
			loadPromise = null;
			if (isUnsupportedNativePlatform({
				platform: deps.platform,
				arch: deps.arch
			})) throw new Error(buildUnsupportedNativePlatformMessage({
				platform: deps.platform,
				arch: deps.arch
			}), { cause: error });
			throw new Error(buildLoadFailureMessage(error), { cause: error });
		});
		return await loadPromise;
	} };
}
const defaultLoader = createLanceDbRuntimeLoader();
async function loadLanceDbModule(logger) {
	return await defaultLoader.load(logger);
}
//#endregion
export { loadLanceDbModule as n, createLanceDbRuntimeLoader as t };
