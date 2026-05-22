import { n as resolveBundledPluginsDir } from "./bundled-dir-DL2yDGTU.js";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/public-surface-runtime.ts
const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [
	".ts",
	".mts",
	".js",
	".mjs",
	".cts",
	".cjs"
];
function normalizeBundledPluginArtifactSubpath(artifactBasename) {
	if (path.posix.isAbsolute(artifactBasename) || path.win32.isAbsolute(artifactBasename) || artifactBasename.includes("\\")) throw new Error(`Bundled plugin artifact path must stay plugin-local: ${artifactBasename}`);
	const normalized = artifactBasename.replace(/^\.\//u, "");
	if (!normalized) throw new Error("Bundled plugin artifact path must not be empty");
	if (normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))) throw new Error(`Bundled plugin artifact path must stay plugin-local: ${artifactBasename}`);
	return normalized;
}
function normalizeBundledPluginDirName(dirName) {
	const normalized = dirName.trim();
	if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\") || normalized.includes(":")) throw new Error(`Bundled plugin dirName must be a single directory: ${dirName}`);
	return normalized;
}
function resolveBundledPluginSourcePublicSurfacePath(params) {
	const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
	const dirName = normalizeBundledPluginDirName(params.dirName);
	const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
	for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
		const sourceCandidate = path.resolve(params.sourceRoot, dirName, `${sourceBaseName}${ext}`);
		if (fs.existsSync(sourceCandidate)) return sourceCandidate;
	}
	return null;
}
function resolvePackageFallbackForBundledDir(params) {
	const normalizedBundledDir = path.resolve(params.bundledPluginsDir);
	const normalizedRootDir = path.resolve(params.rootDir);
	const packageBundledDirs = [path.join(normalizedRootDir, "dist", "extensions"), path.join(normalizedRootDir, "dist-runtime", "extensions")];
	if (!packageBundledDirs.includes(normalizedBundledDir)) return null;
	for (const packageBundledDir of packageBundledDirs) {
		if (packageBundledDir === normalizedBundledDir) continue;
		const builtCandidate = path.join(packageBundledDir, params.dirName, params.artifactBasename);
		if (fs.existsSync(builtCandidate)) return builtCandidate;
	}
	return resolveBundledPluginSourcePublicSurfacePath({
		sourceRoot: path.join(normalizedRootDir, "extensions"),
		dirName: params.dirName,
		artifactBasename: params.artifactBasename
	});
}
function resolveBundledPluginPublicSurfacePath(params) {
	const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
	const dirName = normalizeBundledPluginDirName(params.dirName);
	const explicitBundledPluginsDir = params.bundledPluginsDir ?? resolveBundledPluginsDir(params.env ?? process.env);
	if (explicitBundledPluginsDir) {
		const explicitPluginDir = path.resolve(explicitBundledPluginsDir, dirName);
		const explicitBuiltCandidate = path.join(explicitPluginDir, artifactBasename);
		if (fs.existsSync(explicitBuiltCandidate)) return explicitBuiltCandidate;
		return resolveBundledPluginSourcePublicSurfacePath({
			sourceRoot: explicitBundledPluginsDir,
			dirName,
			artifactBasename
		}) ?? resolvePackageFallbackForBundledDir({
			rootDir: params.rootDir,
			bundledPluginsDir: explicitBundledPluginsDir,
			dirName,
			artifactBasename
		});
	}
	for (const candidate of [path.resolve(params.rootDir, "dist", "extensions", dirName, artifactBasename), path.resolve(params.rootDir, "dist-runtime", "extensions", dirName, artifactBasename)]) if (fs.existsSync(candidate)) return candidate;
	return resolveBundledPluginSourcePublicSurfacePath({
		sourceRoot: path.resolve(params.rootDir, "extensions"),
		dirName,
		artifactBasename
	});
}
//#endregion
export { resolveBundledPluginSourcePublicSurfacePath as a, resolveBundledPluginPublicSurfacePath as i, normalizeBundledPluginArtifactSubpath as n, normalizeBundledPluginDirName as r, PUBLIC_SURFACE_SOURCE_EXTENSIONS as t };
