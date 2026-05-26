import { s as resolveConfigPath } from "./paths-Cw7f9XhU.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-CcqVVqEn.js";
import { l as resolveEffectivePluginActivationState, n as createPluginActivationSource, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { t as isPluginEnabledByDefaultForPlatform } from "./default-enablement-CT7_t1ee.js";
import { t as parseJsonWithJson5Fallback } from "./parse-json-compat-c3237LfJ.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Cy1cBr1u.js";
import { i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { i as configMayNeedPluginAutoEnable, t as applyPluginAutoEnable } from "./plugin-auto-enable-CuCUT4Z1.js";
import { r as resolveRegistryPluginModuleLocationFromRecords } from "./facade-resolution-shared-Dp7n2TN8.js";
import fs from "node:fs";
import JSON5 from "json5";
import path from "node:path";
//#region src/plugin-sdk/facade-activation-check.runtime.ts
const ALWAYS_ALLOWED_RUNTIME_DIR_NAMES = new Set([
	"image-generation-core",
	"media-understanding-core",
	"speech-core"
]);
const EMPTY_FACADE_BOUNDARY_CONFIG = {};
function readFacadeBoundaryConfigSafely() {
	try {
		const sourceSnapshot = getRuntimeConfigSourceSnapshot();
		if (sourceSnapshot) return { rawConfig: sourceSnapshot };
		const runtimeSnapshot = getRuntimeConfigSnapshot();
		if (runtimeSnapshot) return { rawConfig: runtimeSnapshot };
		const configPath = resolveConfigPath();
		if (!fs.existsSync(configPath)) return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG };
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON5.parse(raw);
		return { rawConfig: parsed && typeof parsed === "object" ? parsed : EMPTY_FACADE_BOUNDARY_CONFIG };
	} catch {
		return { rawConfig: EMPTY_FACADE_BOUNDARY_CONFIG };
	}
}
function getFacadeBoundaryResolvedConfig() {
	const { rawConfig } = readFacadeBoundaryConfigSafely();
	const autoEnabled = configMayNeedPluginAutoEnable(rawConfig, process.env) ? applyPluginAutoEnable({
		config: rawConfig,
		env: process.env
	}) : {
		config: rawConfig,
		autoEnabledReasons: {}
	};
	const config = autoEnabled.config;
	return {
		rawConfig,
		config,
		normalizedPluginsConfig: normalizePluginsConfig(config?.plugins),
		activationSource: createPluginActivationSource({ config: rawConfig }),
		autoEnabledReasons: autoEnabled.autoEnabledReasons
	};
}
function getFacadeManifestRegistry(params) {
	return loadPluginManifestRegistry({
		config: getFacadeBoundaryResolvedConfig().config,
		...params.env ? { env: params.env } : {}
	}).plugins;
}
function resolveRegistryPluginModuleLocation(params) {
	return resolveRegistryPluginModuleLocationFromRecords({
		registry: getFacadeManifestRegistry(params.env ? { env: params.env } : {}),
		dirName: params.dirName,
		artifactBasename: params.artifactBasename
	});
}
function readBundledPluginManifestRecordFromDir(params) {
	const manifestPath = path.join(params.pluginsRoot, params.resolvedDirName, "openclaw.plugin.json");
	if (!fs.existsSync(manifestPath)) return null;
	try {
		const raw = parseJsonWithJson5Fallback(fs.readFileSync(manifestPath, "utf8"));
		if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
		return {
			id: raw.id,
			origin: "bundled",
			enabledByDefault: raw.enabledByDefault === true,
			rootDir: path.join(params.pluginsRoot, params.resolvedDirName),
			channels: Array.isArray(raw.channels) ? raw.channels.filter((entry) => typeof entry === "string") : []
		};
	} catch {
		return null;
	}
}
function resolveBundledMetadataManifestRecord(params) {
	if (!params.location) return null;
	if (params.location.modulePath.startsWith(`${params.sourceExtensionsRoot}${path.sep}`)) {
		const resolvedDirName = path.relative(params.sourceExtensionsRoot, params.location.modulePath).split(path.sep)[0];
		if (!resolvedDirName) return null;
		return readBundledPluginManifestRecordFromDir({
			pluginsRoot: params.sourceExtensionsRoot,
			resolvedDirName
		});
	}
	const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
	if (!bundledPluginsDir) return null;
	const normalizedBundledPluginsDir = path.resolve(bundledPluginsDir);
	if (!params.location.modulePath.startsWith(`${normalizedBundledPluginsDir}${path.sep}`)) return null;
	const resolvedDirName = path.relative(normalizedBundledPluginsDir, params.location.modulePath).split(path.sep)[0];
	if (!resolvedDirName) return null;
	return readBundledPluginManifestRecordFromDir({
		pluginsRoot: normalizedBundledPluginsDir,
		resolvedDirName
	});
}
function resolveBundledPluginManifestRecord(params) {
	const metadataRecord = resolveBundledMetadataManifestRecord(params);
	if (metadataRecord) return metadataRecord;
	const registry = getFacadeManifestRegistry(params.env ? { env: params.env } : {});
	return (params.location ? registry.find((plugin) => {
		const normalizedRootDir = path.resolve(plugin.rootDir);
		const normalizedModulePath = path.resolve(params.location.modulePath);
		return normalizedModulePath === normalizedRootDir || normalizedModulePath.startsWith(`${normalizedRootDir}${path.sep}`);
	}) : null) ?? registry.find((plugin) => plugin.id === params.dirName) ?? registry.find((plugin) => path.basename(plugin.rootDir) === params.dirName) ?? registry.find((plugin) => plugin.channels.includes(params.dirName)) ?? null;
}
function resolveTrackedFacadePluginId(params) {
	return resolveBundledPluginManifestRecord(params)?.id ?? params.dirName;
}
function resolveBundledPluginPublicSurfaceAccess(params) {
	if (params.artifactBasename === "runtime-api.js" && ALWAYS_ALLOWED_RUNTIME_DIR_NAMES.has(params.dirName)) return {
		allowed: true,
		pluginId: params.dirName
	};
	const manifestRecord = resolveBundledPluginManifestRecord(params);
	if (!manifestRecord) return {
		allowed: false,
		reason: `no bundled plugin manifest found for ${params.dirName}`
	};
	const { config, normalizedPluginsConfig, activationSource, autoEnabledReasons } = getFacadeBoundaryResolvedConfig();
	return evaluateBundledPluginPublicSurfaceAccess({
		params,
		manifestRecord,
		config,
		normalizedPluginsConfig,
		activationSource,
		autoEnabledReasons
	});
}
function evaluateBundledPluginPublicSurfaceAccess(params) {
	const activationState = resolveEffectivePluginActivationState({
		id: params.manifestRecord.id,
		origin: params.manifestRecord.origin,
		config: params.normalizedPluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.manifestRecord),
		activationSource: params.activationSource,
		autoEnabledReason: params.autoEnabledReasons[params.manifestRecord.id]?.[0]
	});
	if (activationState.enabled) return {
		allowed: true,
		pluginId: params.manifestRecord.id
	};
	return {
		allowed: false,
		pluginId: params.manifestRecord.id,
		reason: activationState.reason ?? "plugin runtime is not activated"
	};
}
function throwForBundledPluginPublicSurfaceAccess(params) {
	const pluginLabel = params.access.pluginId ?? params.request.dirName;
	throw new Error(`Bundled plugin public surface access blocked for "${pluginLabel}" via ${params.request.dirName}/${params.request.artifactBasename}: ${params.access.reason ?? "plugin runtime is not activated"}`);
}
function resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(params) {
	const access = resolveBundledPluginPublicSurfaceAccess(params);
	if (!access.allowed) throwForBundledPluginPublicSurfaceAccess({
		access,
		request: params
	});
	return access;
}
//#endregion
export { evaluateBundledPluginPublicSurfaceAccess, resolveActivatedBundledPluginPublicSurfaceAccessOrThrow, resolveBundledPluginPublicSurfaceAccess, resolveRegistryPluginModuleLocation, resolveTrackedFacadePluginId, throwForBundledPluginPublicSurfaceAccess };
