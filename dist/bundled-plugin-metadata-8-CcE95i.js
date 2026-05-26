import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import { p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { i as loadPluginManifest, r as getPackageManifestMetadata } from "./manifest-Cyo7Vmnr.js";
import { n as getCachedPluginModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { l as resolveLoaderPackageRoot } from "./sdk-alias-BqTLUqwL.js";
import { t as PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "./public-surface-runtime-VRcoSF_P.js";
import { i as buildJsonChannelConfigSchema, r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/bundled-plugin-scan.ts
const RUNTIME_SIDECAR_ARTIFACTS = new Set([
	"helper-api.js",
	"light-runtime-api.js",
	"runtime-api.js",
	"runtime-setter-api.js",
	"thread-bindings-runtime.js"
]);
function normalizeBundledPluginStringList(value) {
	return normalizeTrimmedStringList(value);
}
function rewriteBundledPluginEntryToBuiltPath(entry) {
	if (!entry) return;
	return entry.replace(/^\.\//u, "").replace(/\.[^.]+$/u, ".js");
}
function isTopLevelPublicSurfaceSource(name) {
	if (!PUBLIC_SURFACE_SOURCE_EXTENSIONS.includes(path.extname(name))) return false;
	if (name.startsWith(".") || name.startsWith("test-") || name.includes(".test-")) return false;
	if (name.endsWith(".d.ts")) return false;
	if (/^config-api(\.[cm]?[jt]s)$/u.test(name)) return false;
	return !/(\.test|\.spec)(\.[cm]?[jt]s)$/u.test(name);
}
function deriveBundledPluginIdHint(params) {
	const base = path.basename(params.entryPath, path.extname(params.entryPath));
	if (!params.hasMultipleExtensions) return params.manifestId;
	const packageName = normalizeOptionalString(params.packageName);
	if (!packageName) return `${params.manifestId}/${base}`;
	return `${packageName.includes("/") ? packageName.split("/").pop() ?? packageName : packageName}/${base}`;
}
function collectBundledPluginPublicSurfaceArtifacts(params) {
	const excluded = new Set(normalizeTrimmedStringList([params.sourceEntry, params.setupEntry]).map((entry) => path.basename(entry)));
	const artifacts = fs.readdirSync(params.pluginDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).filter(isTopLevelPublicSurfaceSource).filter((entry) => !excluded.has(entry)).map((entry) => rewriteBundledPluginEntryToBuiltPath(entry)).filter((entry) => typeof entry === "string" && entry.length > 0).toSorted((left, right) => left.localeCompare(right));
	return artifacts.length > 0 ? artifacts : void 0;
}
function collectBundledPluginRuntimeSidecarArtifacts(publicSurfaceArtifacts) {
	if (!publicSurfaceArtifacts) return;
	const artifacts = publicSurfaceArtifacts.filter((artifact) => RUNTIME_SIDECAR_ARTIFACTS.has(artifact));
	return artifacts.length > 0 ? artifacts : void 0;
}
function resolveBundledPluginScanDir(params) {
	const sourceDir = path.join(params.packageRoot, "extensions");
	const runtimeDir = path.join(params.packageRoot, "dist-runtime", "extensions");
	const builtDir = path.join(params.packageRoot, "dist", "extensions");
	if (params.runningFromBuiltArtifact) {
		if (fs.existsSync(builtDir)) return builtDir;
		if (fs.existsSync(runtimeDir)) return runtimeDir;
	}
	if (fs.existsSync(sourceDir)) return sourceDir;
	if (fs.existsSync(runtimeDir) && fs.existsSync(builtDir)) return runtimeDir;
	if (fs.existsSync(builtDir)) return builtDir;
}
//#endregion
//#region src/plugins/bundled-channel-config-metadata.ts
const SOURCE_CONFIG_SCHEMA_CANDIDATES = [
	path.join("src", "config-schema.ts"),
	path.join("src", "config-schema.js"),
	path.join("src", "config-schema.mts"),
	path.join("src", "config-schema.mjs"),
	path.join("src", "config-schema.cts"),
	path.join("src", "config-schema.cjs")
];
const PUBLIC_CONFIG_SURFACE_BASENAMES = ["channel-config-api"];
const moduleLoaders = createPluginModuleLoaderCache();
function isBuiltChannelConfigSchema(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return Boolean(candidate.schema && typeof candidate.schema === "object");
}
function isJsonSchemaConfigSurface(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	if (typeof candidate.safeParse === "function" || typeof candidate.toJSONSchema === "function") return false;
	return typeof candidate.type === "string" || Array.isArray(candidate.anyOf) || Array.isArray(candidate.oneOf) || Array.isArray(candidate.allOf) || Array.isArray(candidate.enum) || Object.prototype.hasOwnProperty.call(candidate, "const");
}
function resolveConfigSchemaExport(imported) {
	for (const [name, value] of Object.entries(imported)) if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) return value;
	for (const [name, value] of Object.entries(imported)) {
		if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) continue;
		if (isBuiltChannelConfigSchema(value)) return value;
		if (isJsonSchemaConfigSurface(value)) return buildJsonChannelConfigSchema(value);
		if (value && typeof value === "object") return buildChannelConfigSchema(value);
	}
	for (const value of Object.values(imported)) if (isBuiltChannelConfigSchema(value)) return value;
	return null;
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
function resolveChannelConfigSchemaModulePath(pluginDir) {
	for (const relativePath of SOURCE_CONFIG_SCHEMA_CANDIDATES) {
		const candidate = path.join(pluginDir, relativePath);
		if (fs.existsSync(candidate)) return candidate;
	}
	for (const basename of PUBLIC_CONFIG_SURFACE_BASENAMES) for (const extension of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
		const candidate = path.join(pluginDir, `${basename}${extension}`);
		if (fs.existsSync(candidate)) return candidate;
	}
}
function loadChannelConfigSurfaceModuleSync(modulePath) {
	try {
		return resolveConfigSchemaExport(getModuleLoader(modulePath)(modulePath));
	} catch {
		return null;
	}
}
function resolvePackageChannelMeta(packageManifest, channelId) {
	const channelMeta = packageManifest?.channel;
	return channelMeta?.id?.trim() === channelId ? channelMeta : void 0;
}
function collectBundledChannelConfigs(params) {
	const channelIds = normalizeBundledPluginStringList(params.manifest.channels);
	const existingChannelConfigs = params.manifest.channelConfigs && Object.keys(params.manifest.channelConfigs).length > 0 ? { ...params.manifest.channelConfigs } : {};
	if (channelIds.length === 0) return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : void 0;
	const surfaceModulePath = resolveChannelConfigSchemaModulePath(params.pluginDir);
	const surface = surfaceModulePath ? loadChannelConfigSurfaceModuleSync(surfaceModulePath) : null;
	for (const channelId of channelIds) {
		const existing = existingChannelConfigs[channelId];
		const channelMeta = resolvePackageChannelMeta(params.packageManifest, channelId);
		const preferOver = normalizeBundledPluginStringList(channelMeta?.preferOver);
		const uiHints = surface?.uiHints || existing?.uiHints ? {
			...surface?.uiHints && Object.keys(surface.uiHints).length > 0 ? surface.uiHints : {},
			...existing?.uiHints && Object.keys(existing.uiHints).length > 0 ? existing.uiHints : {}
		} : void 0;
		if (!surface?.schema && !existing?.schema) continue;
		existingChannelConfigs[channelId] = {
			schema: surface?.schema ?? existing?.schema ?? {},
			...uiHints && Object.keys(uiHints).length > 0 ? { uiHints } : {},
			...surface?.runtime ?? existing?.runtime ? { runtime: surface?.runtime ?? existing?.runtime } : {},
			...normalizeOptionalString(existing?.label) ?? normalizeOptionalString(channelMeta?.label) ? { label: normalizeOptionalString(existing?.label) ?? normalizeOptionalString(channelMeta?.label) } : {},
			...normalizeOptionalString(existing?.description) ?? normalizeOptionalString(channelMeta?.blurb) ? { description: normalizeOptionalString(existing?.description) ?? normalizeOptionalString(channelMeta?.blurb) } : {},
			...existing?.preferOver?.length ? { preferOver: existing.preferOver } : preferOver.length > 0 ? { preferOver } : {},
			...existing?.commands ?? channelMeta?.commands ? { commands: existing?.commands ?? channelMeta?.commands } : {}
		};
	}
	return Object.keys(existingChannelConfigs).length > 0 ? existingChannelConfigs : void 0;
}
//#endregion
//#region src/plugins/bundled-plugin-metadata.ts
const OPENCLAW_PACKAGE_ROOT = resolveLoaderPackageRoot({
	modulePath: fileURLToPath(import.meta.url),
	moduleUrl: import.meta.url
}) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) || CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
function readPackageManifest(pluginDir) {
	return tryReadJsonSync(path.join(pluginDir, "package.json")) ?? void 0;
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
		path.resolve(params.rootDir, "dist-runtime", "extensions", params.pluginDirName ?? ""),
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
		const candidate = resolveBundledPluginEntryCandidate(baseDir, entryPath);
		if (!candidate) continue;
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
function normalizeRelativePluginEntryPath(entryPath) {
	return entryPath.replace(/^\.\//u, "");
}
function resolveBundledPluginEntryCandidate(baseDir, entryPath) {
	const normalizedEntryPath = normalizeRelativePluginEntryPath(entryPath);
	const candidate = path.isAbsolute(normalizedEntryPath) ? path.normalize(normalizedEntryPath) : path.resolve(baseDir, normalizedEntryPath);
	const relative = path.relative(baseDir, candidate);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
	return candidate;
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
		const candidate = resolveBundledPluginEntryCandidate(baseDir, entryPath);
		if (!candidate) continue;
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
//#endregion
export { resolveBundledPluginScanDir as i, resolveBundledPluginRepoEntryPath as n, normalizeBundledPluginStringList as r, resolveBundledPluginGeneratedPath as t };
