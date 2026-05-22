import { t as PluginLruCache } from "./plugin-cache-primitives-BXH3UUqE.js";
import { n as buildPluginLoaderJitiOptions, r as createPluginLoaderModuleCacheKey, u as resolvePluginLoaderModuleConfig } from "./sdk-alias-ozfjRVDq.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createJiti } from "jiti";
//#region src/shared/import-specifier.ts
/**
* On Windows, Node's ESM loader requires absolute paths to be expressed as
* file:// URLs. Raw drive-letter paths like C:\... are parsed as URL schemes.
*/
function toSafeImportPath(specifier) {
	if (process.platform !== "win32") return specifier;
	if (specifier.startsWith("file://")) return specifier;
	if (path.win32.isAbsolute(specifier)) return pathToFileURL(specifier, { windows: true }).href;
	return specifier;
}
//#endregion
//#region src/plugins/native-module-require.ts
const nodeRequire = createRequire(import.meta.url);
function isJavaScriptModulePath(modulePath) {
	return [
		".js",
		".mjs",
		".cjs"
	].includes(path.extname(modulePath).toLowerCase());
}
function tryNativeRequireJavaScriptModule(modulePath, options = {}) {
	if (process.platform === "win32" && options.allowWindows !== true) return { ok: false };
	if (!isJavaScriptModulePath(modulePath)) return { ok: false };
	try {
		return {
			ok: true,
			moduleExport: nodeRequire(modulePath)
		};
	} catch {
		return { ok: false };
	}
}
//#endregion
//#region src/plugins/plugin-module-loader-cache.ts
const DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES = 128;
function createPluginModuleLoaderCache(maxEntries = DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES) {
	return new PluginLruCache(maxEntries);
}
function resolveDefaultPluginModuleLoaderConfig(params) {
	return resolvePluginLoaderModuleConfig({
		modulePath: params.modulePath,
		argv1: params.argvEntry ?? process.argv[1],
		moduleUrl: params.importerUrl,
		...params.preferBuiltDist ? { preferBuiltDist: true } : {},
		...params.pluginSdkResolution ? { pluginSdkResolution: params.pluginSdkResolution } : {}
	});
}
function resolvePluginModuleLoaderCacheEntry(params) {
	const loaderFilename = toSafeImportPath(params.loaderFilename ?? params.modulePath);
	const hasAliasOverride = Boolean(params.aliasMap);
	const hasTryNativeOverride = typeof params.tryNative === "boolean";
	const defaultConfig = hasAliasOverride || hasTryNativeOverride ? resolveDefaultPluginModuleLoaderConfig(params) : null;
	const canReuseDefaultCacheKey = defaultConfig !== null && (!hasAliasOverride || params.aliasMap === defaultConfig.aliasMap) && (!hasTryNativeOverride || params.tryNative === defaultConfig.tryNative);
	const resolved = defaultConfig ? {
		tryNative: params.tryNative ?? defaultConfig.tryNative,
		aliasMap: params.aliasMap ?? defaultConfig.aliasMap,
		cacheKey: canReuseDefaultCacheKey ? defaultConfig.cacheKey : void 0
	} : resolveDefaultPluginModuleLoaderConfig(params);
	const { tryNative, aliasMap } = resolved;
	const cacheKey = resolved.cacheKey ?? createPluginLoaderModuleCacheKey({
		tryNative,
		aliasMap
	});
	return {
		loaderFilename,
		aliasMap,
		tryNative,
		cacheKey,
		scopedCacheKey: `${loaderFilename}::${params.sharedCacheScopeKey ?? (params.cacheScopeKey ? `${params.cacheScopeKey}::${cacheKey}` : cacheKey)}`
	};
}
function createLazySourceTransformLoader(params) {
	let loadWithSourceTransform;
	return () => {
		if (loadWithSourceTransform) return loadWithSourceTransform;
		const jitiLoader = (params.createLoader ?? createJiti)(params.loaderFilename, {
			...buildPluginLoaderJitiOptions(params.aliasMap),
			tryNative: params.tryNative
		});
		loadWithSourceTransform = new Proxy(jitiLoader, { apply(target, thisArg, argArray) {
			const [first, ...rest] = argArray;
			if (typeof first === "string") return Reflect.apply(target, thisArg, [toSafeImportPath(first), ...rest]);
			return Reflect.apply(target, thisArg, argArray);
		} });
		return loadWithSourceTransform;
	};
}
function createPluginModuleLoader(params) {
	const getLoadWithSourceTransform = createLazySourceTransformLoader(params);
	if (!params.tryNative) return ((target, ...rest) => getLoadWithSourceTransform()(target, ...rest));
	return ((target, ...rest) => {
		const native = tryNativeRequireJavaScriptModule(target, { allowWindows: true });
		if (native.ok) return native.moduleExport;
		return getLoadWithSourceTransform()(target, ...rest);
	});
}
function getCachedPluginModuleLoader(params) {
	const cacheEntry = resolvePluginModuleLoaderCacheEntry(params);
	const cached = params.cache.get(cacheEntry.scopedCacheKey);
	if (cached) return cached;
	const loader = createPluginModuleLoader({
		loaderFilename: cacheEntry.loaderFilename,
		aliasMap: cacheEntry.aliasMap,
		tryNative: cacheEntry.tryNative,
		...params.createLoader ? { createLoader: params.createLoader } : {}
	});
	params.cache.set(cacheEntry.scopedCacheKey, loader);
	return loader;
}
function getCachedPluginSourceModuleLoader(params) {
	return getCachedPluginModuleLoader({
		...params,
		tryNative: false
	});
}
//#endregion
export { tryNativeRequireJavaScriptModule as a, isJavaScriptModulePath as i, getCachedPluginModuleLoader as n, toSafeImportPath as o, getCachedPluginSourceModuleLoader as r, createPluginModuleLoaderCache as t };
