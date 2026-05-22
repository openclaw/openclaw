import { t as PluginLruCache } from "./plugin-cache-primitives-WfwcOrBF.js";
import { n as buildPluginLoaderJitiOptions, r as createPluginLoaderModuleCacheKey, u as resolvePluginLoaderModuleConfig } from "./sdk-alias-DiiCKlea.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
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
function isMissingTargetModuleError(error, modulePath) {
	if (error.code !== "MODULE_NOT_FOUND" || typeof error.message !== "string") return false;
	const firstLine = error.message.split("\n", 1)[0] ?? "";
	return firstLine.includes(`'${modulePath}'`) || firstLine.includes(`"${modulePath}"`);
}
function isSourceTransformFallbackError(error, modulePath) {
	if (!error || typeof error !== "object") return false;
	const candidate = error;
	const code = candidate.code;
	return code === "ERR_REQUIRE_ESM" || code === "ERR_REQUIRE_ASYNC_MODULE" || isMissingTargetModuleError(candidate, modulePath);
}
function tryNativeRequireJavaScriptModule(modulePath, options = {}) {
	if (process.platform === "win32" && options.allowWindows !== true) return { ok: false };
	if (!isJavaScriptModulePath(modulePath)) return { ok: false };
	try {
		return {
			ok: true,
			moduleExport: nodeRequire(modulePath)
		};
	} catch (error) {
		const code = error && typeof error === "object" ? error.code : void 0;
		if (!isSourceTransformFallbackError(error, modulePath) && !(options.fallbackOnMissingDependency === true && (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"))) throw error;
		return { ok: false };
	}
}
//#endregion
//#region src/plugins/plugin-module-loader-cache.ts
const DEFAULT_PLUGIN_MODULE_LOADER_CACHE_ENTRIES = 128;
const MAX_TRACKED_SOURCE_TRANSFORM_TARGETS = 24;
const JITI_FACTORY_OVERRIDE_KEY = Symbol.for("openclaw.pluginModuleLoaderJitiFactoryOverride");
const PLUGIN_SDK_IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(?:openclaw|@openclaw)\/plugin-sdk(?:\/[^"']*)?["']/u;
const requireForJiti = createRequire(import.meta.url);
let createJitiLoaderFactory;
const pluginModuleLoaderStats = {
	calls: 0,
	nativeHits: 0,
	nativeMisses: 0,
	sourceTransformForced: 0,
	sourceTransformFallbacks: 0,
	sourceTransformTargets: /* @__PURE__ */ new Map()
};
function recordSourceTransformTarget(target) {
	const current = pluginModuleLoaderStats.sourceTransformTargets.get(target) ?? 0;
	pluginModuleLoaderStats.sourceTransformTargets.set(target, current + 1);
	if (pluginModuleLoaderStats.sourceTransformTargets.size <= MAX_TRACKED_SOURCE_TRANSFORM_TARGETS) return;
	let leastUsedTarget;
	let leastUsedCount = Number.POSITIVE_INFINITY;
	for (const [candidate, count] of pluginModuleLoaderStats.sourceTransformTargets) if (count < leastUsedCount) {
		leastUsedTarget = candidate;
		leastUsedCount = count;
	}
	if (leastUsedTarget) pluginModuleLoaderStats.sourceTransformTargets.delete(leastUsedTarget);
}
function getPluginModuleLoaderStats() {
	return {
		calls: pluginModuleLoaderStats.calls,
		nativeHits: pluginModuleLoaderStats.nativeHits,
		nativeMisses: pluginModuleLoaderStats.nativeMisses,
		sourceTransformForced: pluginModuleLoaderStats.sourceTransformForced,
		sourceTransformFallbacks: pluginModuleLoaderStats.sourceTransformFallbacks,
		topSourceTransformTargets: [...pluginModuleLoaderStats.sourceTransformTargets].toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 8).map(([target, count]) => ({
			target,
			count
		}))
	};
}
function loadCreateJitiLoaderFactory() {
	const override = globalThis[JITI_FACTORY_OVERRIDE_KEY];
	if (override) return override;
	if (createJitiLoaderFactory) return createJitiLoaderFactory;
	const loaded = requireForJiti("jiti");
	if (typeof loaded.createJiti !== "function") throw new Error("jiti module did not export createJiti");
	createJitiLoaderFactory = loaded.createJiti;
	return createJitiLoaderFactory;
}
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
		const jitiLoader = (params.createLoader ?? loadCreateJitiLoaderFactory())(params.loaderFilename, {
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
function shouldForceSourceTransformForPluginSdkAlias(params) {
	if (!params.aliasMap["openclaw/plugin-sdk"] && !params.aliasMap["@openclaw/plugin-sdk"] && !Object.keys(params.aliasMap).some((key) => key.startsWith("openclaw/plugin-sdk/") || key.startsWith("@openclaw/plugin-sdk/"))) return false;
	if (!/\.[cm]?js$/iu.test(params.target)) return false;
	try {
		return PLUGIN_SDK_IMPORT_SPECIFIER_PATTERN.test(fs.readFileSync(params.target, "utf-8"));
	} catch {
		return false;
	}
}
function createPluginModuleLoader(params) {
	const getLoadWithSourceTransform = createLazySourceTransformLoader(params);
	if (!params.tryNative) return ((target, ...rest) => {
		pluginModuleLoaderStats.calls += 1;
		pluginModuleLoaderStats.sourceTransformForced += 1;
		recordSourceTransformTarget(target);
		return getLoadWithSourceTransform()(target, ...rest);
	});
	const getLoadWithAliasTransform = createLazySourceTransformLoader({
		...params,
		tryNative: false
	});
	return ((target, ...rest) => {
		pluginModuleLoaderStats.calls += 1;
		if (shouldForceSourceTransformForPluginSdkAlias({
			target,
			aliasMap: params.aliasMap
		})) {
			pluginModuleLoaderStats.sourceTransformForced += 1;
			recordSourceTransformTarget(target);
			return getLoadWithAliasTransform()(target, ...rest);
		}
		const native = tryNativeRequireJavaScriptModule(target, { allowWindows: true });
		if (native.ok) {
			pluginModuleLoaderStats.nativeHits += 1;
			return native.moduleExport;
		}
		pluginModuleLoaderStats.nativeMisses += 1;
		pluginModuleLoaderStats.sourceTransformFallbacks += 1;
		recordSourceTransformTarget(target);
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
export { isJavaScriptModulePath as a, getPluginModuleLoaderStats as i, getCachedPluginModuleLoader as n, tryNativeRequireJavaScriptModule as o, getCachedPluginSourceModuleLoader as r, toSafeImportPath as s, createPluginModuleLoaderCache as t };
