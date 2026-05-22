import { n as resolveBundledPluginsDir } from "./bundled-dir-DL2yDGTU.js";
import { r as getCachedPluginSourceModuleLoader } from "./plugin-module-loader-cache-B60-0Kx3.js";
import { l as resolveLoaderPackageRoot } from "./sdk-alias-DiiCKlea.js";
import { n as resolveBundledFacadeModuleLocation, t as createFacadeResolutionKey$1 } from "./facade-resolution-shared-C_J6Sr6P.js";
import { a as resetFacadeLoaderStateForTest, i as loadFacadeModuleAtLocationSync$1, r as loadBundledPluginPublicSurfaceModuleSync$1 } from "./facade-loader-CEuC9fQG.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
//#region src/plugin-sdk/facade-runtime.ts
function createLazyFacadeValue(loadFacadeModule, key) {
	return ((...args) => {
		const value = loadFacadeModule()[key];
		if (typeof value !== "function") return value;
		return value(...args);
	});
}
const OPENCLAW_PACKAGE_ROOT = resolveLoaderPackageRoot({
	modulePath: fileURLToPath(import.meta.url),
	moduleUrl: import.meta.url
}) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
function createFacadeResolutionKey(params) {
	const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
	return createFacadeResolutionKey$1({
		...params,
		bundledPluginsDir,
		...params.env ? { env: params.env } : {}
	});
}
function resolveRegistryPluginModuleLocation(params) {
	return loadFacadeActivationCheckRuntime().resolveRegistryPluginModuleLocation({
		...params,
		resolutionKey: createFacadeResolutionKey(params)
	});
}
function resolveFacadeModuleLocationUncached(params) {
	const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
	const bundledLocation = resolveBundledFacadeModuleLocation({
		...params,
		currentModulePath: CURRENT_MODULE_PATH,
		packageRoot: OPENCLAW_PACKAGE_ROOT,
		bundledPluginsDir
	});
	if (bundledLocation) return bundledLocation;
	return resolveRegistryPluginModuleLocation(params);
}
function resolveFacadeModuleLocation(params) {
	return resolveFacadeModuleLocationUncached(params);
}
const nodeRequire = createRequire(import.meta.url);
const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = ["./facade-activation-check.runtime.js", "./facade-activation-check.runtime.ts"];
let facadeActivationCheckRuntimeModule;
const facadeActivationCheckRuntimeLoaders = /* @__PURE__ */ new Map();
function getFacadeActivationCheckRuntimeSourceLoader(modulePath) {
	return getCachedPluginSourceModuleLoader({
		cache: facadeActivationCheckRuntimeLoaders,
		modulePath,
		importerUrl: import.meta.url,
		loaderFilename: import.meta.url,
		aliasMap: {}
	});
}
function loadFacadeActivationCheckRuntimeFromCandidates(loadCandidate) {
	for (const candidate of FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES) try {
		return loadCandidate(candidate);
	} catch {}
}
function loadFacadeActivationCheckRuntime() {
	if (facadeActivationCheckRuntimeModule) return facadeActivationCheckRuntimeModule;
	facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) => nodeRequire(candidate));
	if (facadeActivationCheckRuntimeModule) return facadeActivationCheckRuntimeModule;
	facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) => getFacadeActivationCheckRuntimeSourceLoader(candidate)(candidate));
	if (facadeActivationCheckRuntimeModule) return facadeActivationCheckRuntimeModule;
	throw new Error("Unable to load facade activation check runtime");
}
function loadFacadeModuleAtLocationSync(params) {
	return loadFacadeModuleAtLocationSync$1(params);
}
function buildFacadeActivationCheckParams(params, location = resolveFacadeModuleLocation(params)) {
	return {
		...params,
		location,
		sourceExtensionsRoot: OPENCLAW_SOURCE_EXTENSIONS_ROOT,
		resolutionKey: createFacadeResolutionKey(params)
	};
}
function loadBundledPluginPublicSurfaceModuleSync(params) {
	const location = resolveFacadeModuleLocation(params);
	const trackedPluginId = () => loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(buildFacadeActivationCheckParams(params, location));
	if (!location) return loadBundledPluginPublicSurfaceModuleSync$1({
		...params,
		trackedPluginId
	});
	return loadFacadeModuleAtLocationSync({
		location,
		trackedPluginId,
		runtimeDeps: {
			pluginId: params.dirName,
			...params.env ? { env: params.env } : {}
		}
	});
}
function loadActivatedBundledPluginPublicSurfaceModuleSync(params) {
	loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(buildFacadeActivationCheckParams(params));
	return loadBundledPluginPublicSurfaceModuleSync(params);
}
function tryLoadActivatedBundledPluginPublicSurfaceModuleSync(params) {
	if (!loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(buildFacadeActivationCheckParams(params)).allowed) return null;
	return loadBundledPluginPublicSurfaceModuleSync(params);
}
function resetFacadeRuntimeStateForTest() {
	resetFacadeLoaderStateForTest();
	facadeActivationCheckRuntimeModule = void 0;
	facadeActivationCheckRuntimeLoaders.clear();
}
//#endregion
export { tryLoadActivatedBundledPluginPublicSurfaceModuleSync as a, resetFacadeRuntimeStateForTest as i, loadActivatedBundledPluginPublicSurfaceModuleSync as n, loadBundledPluginPublicSurfaceModuleSync as r, createLazyFacadeValue as t };
