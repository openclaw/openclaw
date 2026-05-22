import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { n as getCachedPluginModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-AdUe8-Mp.js";
import { t as PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "./public-surface-runtime-Bms4ZYL-.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-rJ4BOsjW.js";
import { i as buildJsonChannelConfigSchema, r as buildChannelConfigSchema } from "./config-schema-Cv6_wz1q.js";
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
export { normalizeBundledPluginStringList as a, deriveBundledPluginIdHint as i, collectBundledPluginPublicSurfaceArtifacts as n, resolveBundledPluginScanDir as o, collectBundledPluginRuntimeSidecarArtifacts as r, rewriteBundledPluginEntryToBuiltPath as s, collectBundledChannelConfigs as t };
