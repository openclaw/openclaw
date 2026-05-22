import { i as openBoundaryFileSync } from "./boundary-file-read-oFRaIDYB.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-DL2yDGTU.js";
import { n as getCachedPluginModuleLoader } from "./plugin-module-loader-cache-B60-0Kx3.js";
import { l as resolveLoaderPackageRoot } from "./sdk-alias-DiiCKlea.js";
import { n as resolveBundledFacadeModuleLocation } from "./facade-resolution-shared-C_J6Sr6P.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugin-sdk/facade-loader.ts
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const nodeRequire = createRequire(import.meta.url);
const moduleLoaders = /* @__PURE__ */ new Map();
const loadedFacadeModules = /* @__PURE__ */ new Map();
const loadedFacadePluginIds = /* @__PURE__ */ new Set();
let facadeLoaderSourceTransformFactory;
let cachedOpenClawPackageRoot;
function getSourceTransformFactory() {
	if (facadeLoaderSourceTransformFactory) return facadeLoaderSourceTransformFactory;
	const { createJiti } = nodeRequire("jiti");
	facadeLoaderSourceTransformFactory = createJiti;
	return facadeLoaderSourceTransformFactory;
}
function getOpenClawPackageRoot() {
	if (cachedOpenClawPackageRoot) return cachedOpenClawPackageRoot;
	cachedOpenClawPackageRoot = resolveLoaderPackageRoot({
		modulePath: fileURLToPath(import.meta.url),
		moduleUrl: import.meta.url
	}) ?? fileURLToPath(new URL("../..", import.meta.url));
	return cachedOpenClawPackageRoot;
}
function resolveFacadeModuleLocation(params) {
	const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
	return resolveBundledFacadeModuleLocation({
		...params,
		currentModulePath: CURRENT_MODULE_PATH,
		packageRoot: getOpenClawPackageRoot(),
		bundledPluginsDir
	});
}
function getModuleLoader(modulePath) {
	return getCachedPluginModuleLoader({
		cache: moduleLoaders,
		modulePath,
		importerUrl: import.meta.url,
		preferBuiltDist: true,
		loaderFilename: import.meta.url,
		createLoader: getSourceTransformFactory()
	});
}
function createLazyFacadeValueLoader(load) {
	let loaded = false;
	let value;
	return () => {
		if (!loaded) {
			value = load();
			loaded = true;
		}
		return value;
	};
}
function createLazyFacadeProxyValue(params) {
	const resolve = createLazyFacadeValueLoader(params.load);
	return new Proxy(params.target, {
		defineProperty(_target, property, descriptor) {
			return Reflect.defineProperty(resolve(), property, descriptor);
		},
		deleteProperty(_target, property) {
			return Reflect.deleteProperty(resolve(), property);
		},
		get(_target, property, receiver) {
			return Reflect.get(resolve(), property, receiver);
		},
		getOwnPropertyDescriptor(_target, property) {
			return Reflect.getOwnPropertyDescriptor(resolve(), property);
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(resolve());
		},
		has(_target, property) {
			return Reflect.has(resolve(), property);
		},
		isExtensible() {
			return Reflect.isExtensible(resolve());
		},
		ownKeys() {
			return Reflect.ownKeys(resolve());
		},
		preventExtensions() {
			return Reflect.preventExtensions(resolve());
		},
		set(_target, property, value, receiver) {
			return Reflect.set(resolve(), property, value, receiver);
		},
		setPrototypeOf(_target, prototype) {
			return Reflect.setPrototypeOf(resolve(), prototype);
		}
	});
}
function createLazyFacadeObjectValue(load) {
	return createLazyFacadeProxyValue({
		load,
		target: {}
	});
}
function loadFacadeModuleAtLocationSync(params) {
	const location = params.location;
	const cached = loadedFacadeModules.get(location.modulePath);
	if (cached) return cached;
	const opened = openBoundaryFileSync({
		absolutePath: location.modulePath,
		rootPath: location.boundaryRoot,
		boundaryLabel: location.boundaryRoot === getOpenClawPackageRoot() ? "OpenClaw package root" : (() => {
			const bundledDir = resolveBundledPluginsDir();
			return bundledDir && path.resolve(location.boundaryRoot) === path.resolve(bundledDir) ? "bundled plugin directory" : "plugin root";
		})(),
		rejectHardlinks: false
	});
	if (!opened.ok) throw new Error(`Unable to open bundled plugin public surface ${location.modulePath}`, { cause: opened.error });
	fs.closeSync(opened.fd);
	const sentinel = {};
	loadedFacadeModules.set(location.modulePath, sentinel);
	let loaded;
	try {
		loaded = params.loadModule?.(location.modulePath) ?? getModuleLoader(location.modulePath)(location.modulePath);
		Object.assign(sentinel, loaded);
		loadedFacadePluginIds.add(typeof params.trackedPluginId === "function" ? params.trackedPluginId() : params.trackedPluginId);
	} catch (err) {
		loadedFacadeModules.delete(location.modulePath);
		throw err;
	}
	return sentinel;
}
function loadBundledPluginPublicSurfaceModuleSync(params) {
	const location = resolveFacadeModuleLocation(params);
	if (!location) throw new Error(`Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`);
	return loadFacadeModuleAtLocationSync({
		location,
		trackedPluginId: params.trackedPluginId ?? params.dirName
	});
}
function listImportedBundledPluginFacadeIds() {
	return [...loadedFacadePluginIds].toSorted((left, right) => left.localeCompare(right));
}
function resetFacadeLoaderStateForTest() {
	loadedFacadeModules.clear();
	loadedFacadePluginIds.clear();
	moduleLoaders.clear();
	facadeLoaderSourceTransformFactory = void 0;
	cachedOpenClawPackageRoot = void 0;
}
//#endregion
export { resetFacadeLoaderStateForTest as a, loadFacadeModuleAtLocationSync as i, listImportedBundledPluginFacadeIds as n, loadBundledPluginPublicSurfaceModuleSync as r, createLazyFacadeObjectValue as t };
