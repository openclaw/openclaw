import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { l as resolveLoaderPackageRoot } from "./sdk-alias-ozfjRVDq.js";
import { C as getPackageManifestMetadata, w as loadPluginManifest } from "./discovery-B19Xdk1_.js";
import { a as normalizeBundledPluginStringList, i as deriveBundledPluginIdHint, n as collectBundledPluginPublicSurfaceArtifacts, o as resolveBundledPluginScanDir, r as collectBundledPluginRuntimeSidecarArtifacts, s as rewriteBundledPluginEntryToBuiltPath, t as collectBundledChannelConfigs } from "./bundled-channel-config-metadata-C5ZfJyZy.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/bundled-plugin-metadata.ts
const OPENCLAW_PACKAGE_ROOT = resolveLoaderPackageRoot({
	modulePath: fileURLToPath(import.meta.url),
	moduleUrl: import.meta.url
}) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) || CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
function readPackageManifest(pluginDir) {
	const packagePath = path.join(pluginDir, "package.json");
	if (!fs.existsSync(packagePath)) return;
	try {
		return JSON.parse(fs.readFileSync(packagePath, "utf-8"));
	} catch {
		return;
	}
}
function resolveBundledPluginMetadataScanDir(packageRoot, scanDir) {
	if (scanDir) return path.resolve(scanDir);
	return resolveBundledPluginScanDir({
		packageRoot,
		runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT
	});
}
function resolveBundledPluginLookupParams(params) {
	return params.scanDir ? params : { rootDir: params.rootDir };
}
function collectBundledPluginMetadata(resolvedScanDir, includeChannelConfigs, includeSyntheticChannelConfigs) {
	if (!resolvedScanDir || !fs.existsSync(resolvedScanDir)) return [];
	const entries = [];
	for (const dirName of fs.readdirSync(resolvedScanDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted((left, right) => left.localeCompare(right))) {
		const pluginDir = path.join(resolvedScanDir, dirName);
		const manifestResult = loadPluginManifest(pluginDir, false);
		if (!manifestResult.ok) continue;
		const packageJson = readPackageManifest(pluginDir);
		const packageManifest = getPackageManifestMetadata(packageJson);
		const extensions = normalizeBundledPluginStringList(packageManifest?.extensions);
		if (extensions.length === 0) continue;
		const sourceEntry = normalizeOptionalString(extensions[0]);
		const builtEntry = rewriteBundledPluginEntryToBuiltPath(sourceEntry);
		if (!sourceEntry || !builtEntry) continue;
		const setupSourcePath = normalizeOptionalString(packageManifest?.setupEntry);
		const setupSource = setupSourcePath && rewriteBundledPluginEntryToBuiltPath(setupSourcePath) ? {
			source: setupSourcePath,
			built: rewriteBundledPluginEntryToBuiltPath(setupSourcePath)
		} : void 0;
		const publicSurfaceArtifacts = collectBundledPluginPublicSurfaceArtifacts({
			pluginDir,
			sourceEntry,
			...setupSourcePath ? { setupEntry: setupSourcePath } : {}
		});
		const runtimeSidecarArtifacts = collectBundledPluginRuntimeSidecarArtifacts(publicSurfaceArtifacts);
		const channelConfigs = includeChannelConfigs && includeSyntheticChannelConfigs ? collectBundledChannelConfigs({
			pluginDir,
			manifest: manifestResult.manifest,
			packageManifest
		}) : manifestResult.manifest.channelConfigs;
		entries.push({
			dirName,
			idHint: deriveBundledPluginIdHint({
				entryPath: sourceEntry,
				manifestId: manifestResult.manifest.id,
				packageName: normalizeOptionalString(packageJson?.name),
				hasMultipleExtensions: extensions.length > 1
			}),
			source: {
				source: sourceEntry,
				built: builtEntry
			},
			...setupSource ? { setupSource } : {},
			...publicSurfaceArtifacts ? { publicSurfaceArtifacts } : {},
			...runtimeSidecarArtifacts ? { runtimeSidecarArtifacts } : {},
			...normalizeOptionalString(packageJson?.name) ? { packageName: normalizeOptionalString(packageJson?.name) } : {},
			...normalizeOptionalString(packageJson?.version) ? { packageVersion: normalizeOptionalString(packageJson?.version) } : {},
			...normalizeOptionalString(packageJson?.description) ? { packageDescription: normalizeOptionalString(packageJson?.description) } : {},
			...packageManifest ? { packageManifest } : {},
			manifest: {
				...manifestResult.manifest,
				...channelConfigs ? { channelConfigs } : {}
			}
		});
	}
	return entries;
}
function listBundledPluginMetadata(params) {
	const resolvedScanDir = resolveBundledPluginMetadataScanDir(path.resolve(params?.rootDir ?? OPENCLAW_PACKAGE_ROOT), params?.scanDir ? path.resolve(params.scanDir) : void 0);
	const includeChannelConfigs = params?.includeChannelConfigs ?? !RUNNING_FROM_BUILT_ARTIFACT;
	const includeSyntheticChannelConfigs = params?.includeSyntheticChannelConfigs ?? includeChannelConfigs;
	return Object.freeze(collectBundledPluginMetadata(resolvedScanDir, includeChannelConfigs, includeSyntheticChannelConfigs));
}
function findBundledPluginMetadataById(pluginId, params) {
	return listBundledPluginMetadata(params).find((entry) => entry.manifest.id === pluginId);
}
function listBundledPluginEntryBaseDirs(params) {
	return [
		...params.scanDir ? [path.resolve(params.scanDir, params.pluginDirName ?? "")] : [],
		path.resolve(params.rootDir, "dist", "extensions", params.pluginDirName ?? ""),
		path.resolve(params.rootDir, "extensions", params.pluginDirName ?? "")
	].filter((entry, index, all) => all.indexOf(entry) === index);
}
function resolveBundledPluginGeneratedPath(rootDir, entry, pluginDirName, scanDir) {
	if (!entry) return null;
	const entryOrder = [entry.built, entry.source].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
	const baseDirs = listBundledPluginEntryBaseDirs({
		rootDir,
		pluginDirName,
		...scanDir ? { scanDir } : {}
	});
	for (const baseDir of baseDirs) for (const entryPath of entryOrder) {
		const candidate = path.resolve(baseDir, normalizeRelativePluginEntryPath(entryPath));
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
function normalizeRelativePluginEntryPath(entryPath) {
	return entryPath.replace(/^\.\//u, "");
}
function resolveBundledPluginRepoEntryPath(params) {
	const metadata = findBundledPluginMetadataById(params.pluginId, {
		...resolveBundledPluginLookupParams({
			rootDir: params.rootDir,
			scanDir: params.scanDir
		}),
		includeChannelConfigs: false,
		includeSyntheticChannelConfigs: false
	});
	if (!metadata) return null;
	const entryOrder = params.preferBuilt ? [metadata.source.built, metadata.source.source] : [metadata.source.source, metadata.source.built];
	const baseDirs = listBundledPluginEntryBaseDirs({
		rootDir: params.rootDir,
		pluginDirName: metadata.dirName,
		...params.scanDir ? { scanDir: params.scanDir } : {}
	});
	for (const baseDir of baseDirs) for (const entryPath of entryOrder) {
		const candidate = path.resolve(baseDir, normalizeRelativePluginEntryPath(entryPath));
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
//#endregion
//#region src/plugins/module-export.ts
function unwrapDefaultModuleExport(moduleExport) {
	let resolved = moduleExport;
	const seen = /* @__PURE__ */ new Set();
	while (resolved && typeof resolved === "object" && "default" in resolved && !seen.has(resolved)) {
		seen.add(resolved);
		resolved = resolved.default;
	}
	return resolved;
}
//#endregion
export { resolveBundledPluginGeneratedPath as n, resolveBundledPluginRepoEntryPath as r, unwrapDefaultModuleExport as t };
