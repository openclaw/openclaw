import { t as areBundledPluginsDisabled } from "./bundled-dir-DL2yDGTU.js";
import { a as resolveBundledPluginSourcePublicSurfacePath, i as resolveBundledPluginPublicSurfacePath, n as normalizeBundledPluginArtifactSubpath, t as PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "./public-surface-runtime-DeZe-uL6.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugin-sdk/facade-resolution-shared.ts
function createFacadeResolutionKey(params) {
	const disabledKey = areBundledPluginsDisabled(params.env ?? process.env) ? "disabled" : "enabled";
	return `${params.dirName}::${params.artifactBasename}::${params.bundledPluginsDir ? path.resolve(params.bundledPluginsDir) : "<default>"}::${disabledKey}`;
}
function resolveFacadeBoundaryRoot(params) {
	if (!params.bundledPluginsDir) return params.packageRoot;
	const resolvedBundledPluginsDir = path.resolve(params.bundledPluginsDir);
	return params.modulePath.startsWith(`${resolvedBundledPluginsDir}${path.sep}`) ? resolvedBundledPluginsDir : params.packageRoot;
}
function resolveBundledFacadeModuleLocation(params) {
	const preferSource = !params.currentModulePath.includes(`${path.sep}dist${path.sep}`);
	const env = params.env ?? process.env;
	const packageSourceRoot = path.resolve(params.packageRoot, "extensions");
	const publicSurfaceParams = {
		rootDir: params.packageRoot,
		env: params.env,
		...params.bundledPluginsDir ? { bundledPluginsDir: params.bundledPluginsDir } : {},
		dirName: params.dirName,
		artifactBasename: params.artifactBasename
	};
	const modulePath = preferSource ? resolveBundledPluginSourcePublicSurfacePath({
		dirName: params.dirName,
		artifactBasename: params.artifactBasename,
		sourceRoot: params.bundledPluginsDir ?? packageSourceRoot
	}) ?? (params.bundledPluginsDir && !areBundledPluginsDisabled(env) ? resolveBundledPluginSourcePublicSurfacePath({
		dirName: params.dirName,
		artifactBasename: params.artifactBasename,
		sourceRoot: packageSourceRoot
	}) : null) ?? resolveBundledPluginPublicSurfacePath(publicSurfaceParams) : resolveBundledPluginPublicSurfacePath(publicSurfaceParams);
	return modulePath ? {
		modulePath,
		boundaryRoot: resolveFacadeBoundaryRoot({
			modulePath,
			bundledPluginsDir: params.bundledPluginsDir,
			packageRoot: params.packageRoot
		})
	} : null;
}
function resolveRegistryPluginModuleLocationFromRecords(params) {
	const tiers = [
		(plugin) => plugin.id === params.dirName,
		(plugin) => path.basename(plugin.rootDir) === params.dirName,
		(plugin) => plugin.channels.includes(params.dirName)
	];
	const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
	const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
	for (const matchFn of tiers) for (const record of params.registry.filter(matchFn)) {
		const rootDir = path.resolve(record.rootDir);
		const builtCandidate = path.join(rootDir, artifactBasename);
		if (fs.existsSync(builtCandidate)) return {
			modulePath: builtCandidate,
			boundaryRoot: rootDir
		};
		for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
			const sourceCandidate = path.join(rootDir, `${sourceBaseName}${ext}`);
			if (fs.existsSync(sourceCandidate)) return {
				modulePath: sourceCandidate,
				boundaryRoot: rootDir
			};
		}
	}
	return null;
}
//#endregion
export { resolveBundledFacadeModuleLocation as n, resolveRegistryPluginModuleLocationFromRecords as r, createFacadeResolutionKey as t };
