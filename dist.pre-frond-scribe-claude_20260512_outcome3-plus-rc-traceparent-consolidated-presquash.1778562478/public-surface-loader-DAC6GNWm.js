import { n as sameFileIdentity } from "./safe-open-sync-BVLkOkpr.js";
import { i as openBoundaryFileSync } from "./boundary-file-read-oFRaIDYB.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-DL2yDGTU.js";
import { n as getCachedPluginModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-B60-0Kx3.js";
import { d as resolvePluginLoaderTryNative, l as resolveLoaderPackageRoot } from "./sdk-alias-DiiCKlea.js";
import { i as resolveBundledPluginPublicSurfacePath } from "./public-surface-runtime-DeZe-uL6.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/public-surface-loader.ts
const OPENCLAW_PACKAGE_ROOT = resolveLoaderPackageRoot({
	modulePath: fileURLToPath(import.meta.url),
	moduleUrl: import.meta.url
}) ?? fileURLToPath(new URL("../..", import.meta.url));
const publicSurfaceModuleCache = /* @__PURE__ */ new Map();
const sourceArtifactRequire = createRequire(import.meta.url);
const publicSurfaceLocationCache = /* @__PURE__ */ new Map();
const moduleLoaders = createPluginModuleLoaderCache();
function isSourceArtifactPath(modulePath) {
	switch (path.extname(modulePath).toLowerCase()) {
		case ".ts":
		case ".tsx":
		case ".mts":
		case ".cts":
		case ".mtsx":
		case ".ctsx": return true;
		default: return false;
	}
}
function canUseSourceArtifactRequire(params) {
	return !params.tryNative && isSourceArtifactPath(params.modulePath) && typeof sourceArtifactRequire.extensions?.[".ts"] === "function";
}
function createResolutionKey(params) {
	const bundledPluginsDir = resolveBundledPluginsDir();
	return `${params.dirName}::${params.artifactBasename}::${bundledPluginsDir ? path.resolve(bundledPluginsDir) : "<default>"}`;
}
function resolvePublicSurfaceLocationUncached(params) {
	const bundledPluginsDir = resolveBundledPluginsDir();
	const modulePath = resolveBundledPluginPublicSurfacePath({
		rootDir: OPENCLAW_PACKAGE_ROOT,
		...bundledPluginsDir ? { bundledPluginsDir } : {},
		dirName: params.dirName,
		artifactBasename: params.artifactBasename
	});
	if (!modulePath) return null;
	return {
		modulePath,
		boundaryRoot: bundledPluginsDir && modulePath.startsWith(path.resolve(bundledPluginsDir) + path.sep) ? path.resolve(bundledPluginsDir) : OPENCLAW_PACKAGE_ROOT
	};
}
function resolvePublicSurfaceLocation(params) {
	const key = createResolutionKey(params);
	const cached = publicSurfaceLocationCache.get(key);
	if (cached) return cached;
	const resolved = resolvePublicSurfaceLocationUncached(params);
	if (resolved) publicSurfaceLocationCache.set(key, resolved);
	return resolved;
}
function getModuleLoader(modulePath) {
	return getCachedPluginModuleLoader({
		cache: moduleLoaders,
		modulePath,
		importerUrl: import.meta.url,
		preferBuiltDist: true,
		loaderFilename: import.meta.url
	});
}
function loadPublicSurfaceModule(modulePath) {
	if (canUseSourceArtifactRequire({
		modulePath,
		tryNative: resolvePluginLoaderTryNative(modulePath, { preferBuiltDist: true })
	})) return sourceArtifactRequire(modulePath);
	return getModuleLoader(modulePath)(modulePath);
}
function loadBundledPluginPublicArtifactModuleSync(params) {
	const location = resolvePublicSurfaceLocation(params);
	if (!location) throw new Error(`Unable to resolve bundled plugin public surface ${params.dirName}/${params.artifactBasename}`);
	const cached = publicSurfaceModuleCache.get(location.modulePath);
	if (cached) return cached;
	const opened = openBoundaryFileSync({
		absolutePath: location.modulePath,
		rootPath: location.boundaryRoot,
		boundaryLabel: location.boundaryRoot === OPENCLAW_PACKAGE_ROOT ? "OpenClaw package root" : "plugin root",
		rejectHardlinks: true
	});
	if (!opened.ok) throw new Error(`Unable to open bundled plugin public surface ${params.dirName}/${params.artifactBasename}`, { cause: opened.error });
	const validatedPath = opened.path;
	const validatedStat = opened.stat;
	fs.closeSync(opened.fd);
	if (!sameFileIdentity(validatedStat, fs.statSync(validatedPath))) throw new Error(`Bundled plugin public surface changed after validation: ${params.dirName}/${params.artifactBasename}`);
	const sentinel = {};
	publicSurfaceModuleCache.set(location.modulePath, sentinel);
	publicSurfaceModuleCache.set(validatedPath, sentinel);
	try {
		const loaded = loadPublicSurfaceModule(validatedPath);
		Object.assign(sentinel, loaded);
		return sentinel;
	} catch (error) {
		publicSurfaceModuleCache.delete(location.modulePath);
		publicSurfaceModuleCache.delete(validatedPath);
		throw error;
	}
}
//#endregion
export { loadBundledPluginPublicArtifactModuleSync as t };
