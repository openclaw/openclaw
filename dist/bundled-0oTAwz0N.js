import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as resolveOpenClawPackageRootSync } from "./openclaw-root-CNp1Ofdk.js";
import { i as formatErrorMessage, r as extractErrorCode } from "./errors-b3ZrCRlt.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { i as openRootFileSync } from "./root-file-jRMCpJW4.js";
import "./path-guards-CBe_wA_B.js";
import "./boundary-file-read-CBe_wA_B.js";
import { n as resolveBundledPluginsDir } from "./bundled-dir-CcqVVqEn.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-CgH_ZSlH.js";
import { a as isJavaScriptModulePath, n as getCachedPluginModuleLoader } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as passesManifestOwnerBasePolicy } from "./manifest-owner-policy-DqV-lgQl.js";
import { t as resolveBundledPluginGeneratedPath } from "./bundled-plugin-metadata-8-CcE95i.js";
import { t as unwrapDefaultModuleExport } from "./module-export-COvD9dVR.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/channels/plugins/module-loader.ts
const nodeRequire = createRequire(import.meta.url);
const SOURCE_MODULE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts"
]);
const jitiLoaders = /* @__PURE__ */ new Map();
function hasNativeSourceRequireHook(modulePath) {
	const extension = path.extname(modulePath).toLowerCase();
	return SOURCE_MODULE_EXTENSIONS.has(extension) && typeof nodeRequire.extensions?.[extension] === "function";
}
function isSourceModulePath$1(modulePath) {
	return SOURCE_MODULE_EXTENSIONS.has(path.extname(modulePath).toLowerCase());
}
function loadModuleWithJiti(modulePath) {
	return getCachedPluginModuleLoader({
		cache: jitiLoaders,
		modulePath,
		importerUrl: import.meta.url,
		loaderFilename: import.meta.url,
		tryNative: false,
		cacheScopeKey: "channel-plugin-module-loader"
	})(modulePath);
}
function loadModule(modulePath) {
	if (!isJavaScriptModulePath(modulePath) && !hasNativeSourceRequireHook(modulePath)) {
		if (isSourceModulePath$1(modulePath)) return loadModuleWithJiti(modulePath);
		throw new Error(`channel plugin module must be built JavaScript: ${modulePath}`);
	}
	try {
		return nodeRequire(modulePath);
	} catch (error) {
		if (isSourceModulePath$1(modulePath)) return loadModuleWithJiti(modulePath);
		throw new Error(`failed to load channel plugin module with native require: ${modulePath}`, { cause: error });
	}
}
function resolvePluginModuleCandidates(rootDir, specifier) {
	const normalizedSpecifier = specifier.replace(/\\/g, "/");
	const resolvedPath = path.resolve(rootDir, normalizedSpecifier);
	if (path.extname(resolvedPath)) return [resolvedPath];
	return [
		resolvedPath,
		`${resolvedPath}.ts`,
		`${resolvedPath}.mts`,
		`${resolvedPath}.js`,
		`${resolvedPath}.mjs`,
		`${resolvedPath}.cts`,
		`${resolvedPath}.cjs`
	];
}
function resolveExistingPluginModulePath(rootDir, specifier) {
	for (const candidate of resolvePluginModuleCandidates(rootDir, specifier)) if (fs.existsSync(candidate)) return candidate;
	return path.resolve(rootDir, specifier);
}
function loadChannelPluginModule(params) {
	const opened = openRootFileSync({
		absolutePath: params.modulePath,
		rootPath: params.boundaryRootDir ?? params.rootDir,
		boundaryLabel: params.boundaryLabel ?? "plugin root",
		rejectHardlinks: false,
		skipLexicalRootCheck: true
	});
	if (!opened.ok) throw new Error(`${params.boundaryLabel ?? "plugin"} module path escapes plugin root or fails alias checks`);
	const safePath = opened.path;
	fs.closeSync(opened.fd);
	return loadModule(safePath);
}
//#endregion
//#region src/channels/plugins/bundled-root.ts
const OPENCLAW_PACKAGE_ROOT = resolveOpenClawPackageRootSync({
	argv1: process.argv[1],
	cwd: process.cwd(),
	moduleUrl: import.meta.url.startsWith("file:") ? import.meta.url : void 0
}) ?? (import.meta.url.startsWith("file:") ? path.resolve(fileURLToPath(new URL("../../..", import.meta.url))) : process.cwd());
function derivePackageRootFromExtensionsDir(extensionsDir) {
	const parentDir = path.dirname(extensionsDir);
	const parentBase = path.basename(parentDir);
	if (parentBase === "dist" || parentBase === "dist-runtime") return path.dirname(parentDir);
	return parentDir;
}
function resolveBundledChannelRootScope(env = process.env) {
	const bundledPluginsDir = resolveBundledPluginsDir(env);
	if (!bundledPluginsDir) return {
		packageRoot: OPENCLAW_PACKAGE_ROOT,
		cacheKey: OPENCLAW_PACKAGE_ROOT
	};
	const resolvedPluginsDir = path.resolve(bundledPluginsDir);
	return {
		packageRoot: path.basename(resolvedPluginsDir) === "extensions" ? derivePackageRootFromExtensionsDir(resolvedPluginsDir) : resolvedPluginsDir,
		cacheKey: resolvedPluginsDir,
		pluginsDir: resolvedPluginsDir
	};
}
//#endregion
//#region src/plugins/bundled-channel-runtime.ts
function resolveBundledMetadataScope(params) {
	const overrideDir = params?.scanDir ? path.resolve(params.scanDir) : params?.rootDir ? resolveBundledPluginsDirForRoot(params.rootDir) : void 0;
	if (!overrideDir) return params?.rootDir ? { kind: "empty" } : { kind: "default" };
	if (!fs.existsSync(overrideDir)) return { kind: "empty" };
	return {
		kind: "env",
		env: {
			...process.env,
			OPENCLAW_BUNDLED_PLUGINS_DIR: overrideDir,
			OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1"
		}
	};
}
function resolveBundledPluginsDirForRoot(rootDir) {
	return [
		path.join(rootDir, "extensions"),
		path.join(rootDir, "dist-runtime", "extensions"),
		path.join(rootDir, "dist", "extensions")
	].find((candidate) => fs.existsSync(candidate));
}
function toBundledChannelEntryPair(source) {
	if (!source) return null;
	return {
		source,
		built: source
	};
}
function toBundledChannelPluginMetadata(record) {
	if (record.origin !== "bundled") return null;
	const source = toBundledChannelEntryPair(record.source);
	if (!source) return null;
	const setupSource = toBundledChannelEntryPair(record.setupSource);
	return {
		dirName: path.basename(record.rootDir),
		source,
		...setupSource ? { setupSource } : {},
		manifest: {
			id: record.id,
			channels: record.channels
		},
		...record.packageManifest ? { packageManifest: record.packageManifest } : {},
		rootDir: record.rootDir
	};
}
function listBundledChannelPluginMetadata(params) {
	const scope = resolveBundledMetadataScope(params);
	if (scope.kind === "empty") return [];
	return loadPluginManifestRegistryForPluginRegistry({
		env: scope.kind === "env" ? scope.env : void 0,
		includeDisabled: true
	}).plugins.flatMap((record) => toBundledChannelPluginMetadata(record) ?? []);
}
function resolveBundledChannelGeneratedPath(rootDir, entry, pluginDirName, scanDir) {
	return resolveBundledPluginGeneratedPath(rootDir, entry, pluginDirName, scanDir);
}
//#endregion
//#region src/channels/plugins/meta-normalization.ts
function stripRequiredChannelMeta(meta) {
	const { id: _ignoredId, label: _ignoredLabel, selectionLabel: _ignoredSelectionLabel, docsPath: _ignoredDocsPath, blurb: _ignoredBlurb, ...rest } = meta ?? {};
	return rest;
}
function normalizeChannelMeta(params) {
	const next = params.meta ?? void 0;
	const existing = params.existing ?? void 0;
	const label = normalizeOptionalString(next?.label) ?? normalizeOptionalString(existing?.label) ?? normalizeOptionalString(next?.selectionLabel) ?? normalizeOptionalString(existing?.selectionLabel) ?? params.id;
	const selectionLabel = normalizeOptionalString(next?.selectionLabel) ?? normalizeOptionalString(existing?.selectionLabel) ?? label;
	const docsPath = normalizeOptionalString(next?.docsPath) ?? normalizeOptionalString(existing?.docsPath) ?? `/channels/${params.id}`;
	const blurb = normalizeOptionalString(next?.blurb) ?? normalizeOptionalString(existing?.blurb) ?? "";
	return {
		...stripRequiredChannelMeta(existing),
		...stripRequiredChannelMeta(next),
		id: params.id,
		label,
		selectionLabel,
		docsPath,
		blurb
	};
}
//#endregion
//#region src/channels/plugins/bundled.ts
const log = createSubsystemLogger("channels");
const MAX_BUNDLED_CHANNEL_LOAD_CONTEXTS = 32;
const MAX_BUNDLED_CHANNEL_BOUNDARY_ROOTS = 256;
const bundledChannelLoadContextsByRoot = /* @__PURE__ */ new Map();
const bundledChannelBoundaryRoots = /* @__PURE__ */ new Map();
const sourceBundledEntryLoaderCache = /* @__PURE__ */ new Map();
function isSourceModulePath(modulePath) {
	return /\.(?:c|m)?tsx?$/iu.test(modulePath);
}
function resolveChannelPluginModuleEntry(moduleExport) {
	const resolved = unwrapDefaultModuleExport(moduleExport);
	if (!resolved || typeof resolved !== "object") return null;
	const record = resolved;
	if (record.kind !== "bundled-channel-entry") return null;
	if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.description !== "string" || typeof record.register !== "function" || typeof record.loadChannelPlugin !== "function") return null;
	return record;
}
function resolveChannelSetupModuleEntry(moduleExport) {
	const resolved = unwrapDefaultModuleExport(moduleExport);
	if (!resolved || typeof resolved !== "object") return null;
	const record = resolved;
	if (record.kind !== "bundled-channel-setup-entry") return null;
	if (typeof record.loadSetupPlugin !== "function") return null;
	return record;
}
function hasSetupEntryFeature(entry, feature) {
	return entry?.features?.[feature] === true;
}
function resolveBundledChannelBoundaryRoot(params) {
	const cacheKey = [
		params.packageRoot,
		params.pluginsDir ?? "",
		params.metadata.dirName,
		params.modulePath
	].join("\0");
	const cached = bundledChannelBoundaryRoots.get(cacheKey);
	if (cached) {
		bundledChannelBoundaryRoots.delete(cacheKey);
		bundledChannelBoundaryRoots.set(cacheKey, cached);
		return cached;
	}
	const isModuleUnderRoot = (root) => isPathInside(path.resolve(root), params.modulePath);
	const overrideRoot = params.pluginsDir ? path.resolve(params.pluginsDir, params.metadata.dirName) : null;
	let boundaryRoot;
	if (overrideRoot && isModuleUnderRoot(overrideRoot)) boundaryRoot = overrideRoot;
	else {
		const distRoot = path.resolve(params.packageRoot, "dist", "extensions", params.metadata.dirName);
		if (isModuleUnderRoot(distRoot)) boundaryRoot = distRoot;
		else {
			const distRuntimeRoot = path.resolve(params.packageRoot, "dist-runtime", "extensions", params.metadata.dirName);
			boundaryRoot = isModuleUnderRoot(distRuntimeRoot) ? distRuntimeRoot : path.resolve(params.packageRoot, "extensions", params.metadata.dirName);
		}
	}
	bundledChannelBoundaryRoots.set(cacheKey, boundaryRoot);
	while (bundledChannelBoundaryRoots.size > MAX_BUNDLED_CHANNEL_BOUNDARY_ROOTS) {
		const oldestKey = bundledChannelBoundaryRoots.keys().next().value;
		if (oldestKey === void 0) break;
		bundledChannelBoundaryRoots.delete(oldestKey);
	}
	return boundaryRoot;
}
function resolveBundledChannelScanDir(rootScope) {
	return rootScope.pluginsDir;
}
function resolveGeneratedBundledChannelModulePath(params) {
	if (!params.entry) return null;
	return resolveBundledChannelGeneratedPath(params.rootScope.packageRoot, params.entry, params.metadata.dirName, resolveBundledChannelScanDir(params.rootScope));
}
function loadGeneratedBundledChannelModule(params) {
	let modulePath = resolveGeneratedBundledChannelModulePath(params);
	if (!modulePath) throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
	const scanDir = resolveBundledChannelScanDir(params.rootScope);
	let boundaryRoot = resolveBundledChannelBoundaryRoot({
		packageRoot: params.rootScope.packageRoot,
		...scanDir ? { pluginsDir: scanDir } : {},
		metadata: params.metadata,
		modulePath
	});
	try {
		return loadChannelPluginModule({
			modulePath,
			rootDir: boundaryRoot,
			boundaryRootDir: boundaryRoot
		});
	} catch (error) {
		if (!isSourceModulePath(modulePath)) throw error;
		return getCachedPluginModuleLoader({
			cache: sourceBundledEntryLoaderCache,
			modulePath,
			importerUrl: import.meta.url,
			preferBuiltDist: true,
			cacheScopeKey: "bundled-channel-source-entry"
		})(modulePath);
	}
}
function findMissingModuleCodeInChain(error) {
	const seen = /* @__PURE__ */ new Set();
	let current = error;
	while (current && !seen.has(current)) {
		seen.add(current);
		const code = extractErrorCode(current);
		if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return code;
		if (typeof current !== "object") return;
		current = current.cause;
	}
}
function describeBundledChannelLoadError(error, channelId) {
	const detail = formatErrorMessage(error);
	if (findMissingModuleCodeInChain(error) !== void 0) return `${detail} (run \`openclaw doctor --fix\` to install missing bundled runtime dependencies for channel ${channelId})`;
	return detail;
}
function loadGeneratedBundledChannelEntry(params) {
	try {
		const entry = resolveChannelPluginModuleEntry(loadGeneratedBundledChannelModule({
			rootScope: params.rootScope,
			metadata: params.metadata,
			entry: params.metadata.source
		}));
		if (!entry) {
			log.warn(`[channels] bundled channel entry ${params.metadata.manifest.id} missing bundled-channel-entry contract; skipping`);
			return null;
		}
		return {
			id: params.metadata.manifest.id,
			entry
		};
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, params.metadata.manifest.id);
		log.warn(`[channels] failed to load bundled channel ${params.metadata.manifest.id}: ${detail}`);
		return null;
	}
}
function loadGeneratedBundledChannelSetupEntry(params) {
	if (!params.metadata.setupSource) return null;
	try {
		const setupEntry = resolveChannelSetupModuleEntry(loadGeneratedBundledChannelModule({
			rootScope: params.rootScope,
			metadata: params.metadata,
			entry: params.metadata.setupSource
		}));
		if (!setupEntry) {
			log.warn(`[channels] bundled channel setup entry ${params.metadata.manifest.id} missing bundled-channel-setup-entry contract; skipping`);
			return null;
		}
		return setupEntry;
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, params.metadata.manifest.id);
		log.warn(`[channels] failed to load bundled channel setup entry ${params.metadata.manifest.id}: ${detail}`);
		return null;
	}
}
function createBundledChannelLoadContext() {
	return {
		pluginLoadInProgressIds: /* @__PURE__ */ new Set(),
		setupPluginLoadInProgressIds: /* @__PURE__ */ new Set(),
		entryLoadInProgressIds: /* @__PURE__ */ new Set(),
		setupEntryLoadInProgressIds: /* @__PURE__ */ new Set(),
		lazyEntriesById: /* @__PURE__ */ new Map(),
		lazySetupEntriesById: /* @__PURE__ */ new Map(),
		lazyPluginsById: /* @__PURE__ */ new Map(),
		lazySetupPluginsById: /* @__PURE__ */ new Map(),
		lazySecretsById: /* @__PURE__ */ new Map(),
		lazySetupSecretsById: /* @__PURE__ */ new Map(),
		lazyAccountInspectorsById: /* @__PURE__ */ new Map()
	};
}
function resolveActiveBundledChannelLoadScope(env = process.env) {
	const rootScope = resolveBundledChannelRootScope(env);
	const cachedContext = bundledChannelLoadContextsByRoot.get(rootScope.cacheKey);
	if (cachedContext) {
		bundledChannelLoadContextsByRoot.delete(rootScope.cacheKey);
		bundledChannelLoadContextsByRoot.set(rootScope.cacheKey, cachedContext);
		return {
			rootScope,
			loadContext: cachedContext
		};
	}
	const loadContext = createBundledChannelLoadContext();
	bundledChannelLoadContextsByRoot.set(rootScope.cacheKey, loadContext);
	while (bundledChannelLoadContextsByRoot.size > MAX_BUNDLED_CHANNEL_LOAD_CONTEXTS) {
		const oldestKey = bundledChannelLoadContextsByRoot.keys().next().value;
		if (oldestKey === void 0) break;
		bundledChannelLoadContextsByRoot.delete(oldestKey);
	}
	return {
		rootScope,
		loadContext
	};
}
function listBundledChannelMetadata(rootScope = resolveBundledChannelRootScope()) {
	const scanDir = resolveBundledChannelScanDir(rootScope);
	return listBundledChannelPluginMetadata({
		rootDir: rootScope.packageRoot,
		...scanDir ? { scanDir } : {},
		includeChannelConfigs: false,
		includeSyntheticChannelConfigs: false
	}).filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0);
}
function listBundledChannelPluginIdsForRoot(rootScope) {
	return listBundledChannelMetadata(rootScope).map((metadata) => metadata.manifest.id).toSorted((left, right) => left.localeCompare(right));
}
function shouldIncludeBundledChannelSetupFeatureForConfig(params) {
	if (!params.config) return true;
	const pluginId = params.metadata.manifest.id;
	if (!passesManifestOwnerBasePolicy({
		plugin: { id: pluginId },
		normalizedConfig: normalizePluginsConfig(params.config.plugins),
		allowRestrictiveAllowlistBypass: true
	})) return false;
	let hasExplicitChannelDisable = false;
	for (const channelId of params.metadata.manifest.channels ?? [pluginId]) {
		const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
		if (!normalizedChannelId) continue;
		const channelConfig = params.config.channels?.[normalizedChannelId];
		if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) continue;
		if (channelConfig.enabled === false) {
			hasExplicitChannelDisable = true;
			continue;
		}
		return true;
	}
	return !hasExplicitChannelDisable;
}
function listBundledChannelPluginIdsForSetupFeature(rootScope, feature, options = {}) {
	const hinted = listBundledChannelMetadata(rootScope).filter((metadata) => metadata.packageManifest?.setupFeatures?.[feature] === true && shouldIncludeBundledChannelSetupFeatureForConfig({
		metadata,
		config: options.config
	})).map((metadata) => metadata.manifest.id).toSorted((left, right) => left.localeCompare(right));
	return hinted.length > 0 ? hinted : listBundledChannelMetadata(rootScope).filter((metadata) => shouldIncludeBundledChannelSetupFeatureForConfig({
		metadata,
		config: options.config
	})).map((metadata) => metadata.manifest.id).toSorted((left, right) => left.localeCompare(right));
}
function listBundledChannelPluginIds() {
	return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope());
}
function hasBundledChannelPackageSetupFeature(id, feature) {
	return resolveBundledChannelMetadata(id, resolveBundledChannelRootScope())?.packageManifest?.setupFeatures?.[feature] === true;
}
function resolveBundledChannelMetadata(id, rootScope) {
	return listBundledChannelMetadata(rootScope).find((metadata) => metadata.manifest.id === id || metadata.manifest.channels?.includes(id));
}
function getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext) {
	const previous = loadContext.lazyEntriesById.get(id);
	if (previous) return previous;
	if (previous === null) return null;
	const metadata = resolveBundledChannelMetadata(id, rootScope);
	if (!metadata) {
		loadContext.lazyEntriesById.set(id, null);
		return null;
	}
	if (loadContext.entryLoadInProgressIds.has(id)) return null;
	loadContext.entryLoadInProgressIds.add(id);
	try {
		const entry = loadGeneratedBundledChannelEntry({
			rootScope,
			metadata
		});
		loadContext.lazyEntriesById.set(id, entry);
		if (entry?.entry.id && entry.entry.id !== id) loadContext.lazyEntriesById.set(entry.entry.id, entry);
		return entry;
	} finally {
		loadContext.entryLoadInProgressIds.delete(id);
	}
}
function rememberBundledChannelSetupEntry(metadata, loadContext, entry, requestedId) {
	const ids = new Set([
		metadata.manifest.id,
		...metadata.manifest.channels ?? [],
		...requestedId ? [requestedId] : []
	]);
	for (const id of ids) loadContext.lazySetupEntriesById.set(id, entry);
}
function getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext) {
	if (loadContext.lazySetupEntriesById.has(id)) return loadContext.lazySetupEntriesById.get(id) ?? null;
	const metadata = resolveBundledChannelMetadata(id, rootScope);
	if (!metadata) {
		loadContext.lazySetupEntriesById.set(id, null);
		return null;
	}
	if (loadContext.setupEntryLoadInProgressIds.has(id)) return null;
	loadContext.setupEntryLoadInProgressIds.add(id);
	try {
		const setupEntry = loadGeneratedBundledChannelSetupEntry({
			rootScope,
			metadata
		});
		rememberBundledChannelSetupEntry(metadata, loadContext, setupEntry, id);
		return setupEntry;
	} finally {
		loadContext.setupEntryLoadInProgressIds.delete(id);
	}
}
function getBundledChannelPluginForRoot(id, rootScope, loadContext) {
	if (loadContext.lazyPluginsById.has(id)) return loadContext.lazyPluginsById.get(id) ?? void 0;
	if (loadContext.pluginLoadInProgressIds.has(id)) return;
	const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
	if (!entry) return;
	loadContext.pluginLoadInProgressIds.add(id);
	try {
		const metadata = resolveBundledChannelMetadata(id, rootScope);
		const plugin = entry.loadChannelPlugin();
		if (!plugin) {
			loadContext.lazyPluginsById.set(id, null);
			return;
		}
		const normalizedPlugin = {
			...plugin,
			meta: normalizeChannelMeta({
				id: plugin.id,
				meta: plugin.meta,
				existing: metadata?.packageManifest?.channel
			})
		};
		loadContext.lazyPluginsById.set(id, normalizedPlugin);
		return normalizedPlugin;
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, id);
		log.warn(`[channels] failed to load bundled channel ${id}: ${detail}`);
		loadContext.lazyPluginsById.set(id, null);
		return;
	} finally {
		loadContext.pluginLoadInProgressIds.delete(id);
	}
}
function getBundledChannelSecretsForRoot(id, rootScope, loadContext) {
	if (loadContext.lazySecretsById.has(id)) return loadContext.lazySecretsById.get(id) ?? void 0;
	const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
	if (!entry) return;
	try {
		const secrets = entry.loadChannelSecrets?.() ?? getBundledChannelPluginForRoot(id, rootScope, loadContext)?.secrets;
		loadContext.lazySecretsById.set(id, secrets ?? null);
		return secrets;
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, id);
		log.warn(`[channels] failed to load bundled channel secrets ${id}: ${detail}`);
		loadContext.lazySecretsById.set(id, null);
		return;
	}
}
function getBundledChannelAccountInspectorForRoot(id, rootScope, loadContext) {
	if (loadContext.lazyAccountInspectorsById.has(id)) return loadContext.lazyAccountInspectorsById.get(id) ?? void 0;
	const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
	if (!entry?.loadChannelAccountInspector) {
		loadContext.lazyAccountInspectorsById.set(id, null);
		return;
	}
	try {
		const inspector = entry.loadChannelAccountInspector();
		loadContext.lazyAccountInspectorsById.set(id, inspector);
		return inspector;
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, id);
		log.warn(`[channels] failed to load bundled channel account inspector ${id}: ${detail}`);
		loadContext.lazyAccountInspectorsById.set(id, null);
		return;
	}
}
function getBundledChannelSetupPluginForRoot(id, rootScope, loadContext) {
	if (loadContext.lazySetupPluginsById.has(id)) return loadContext.lazySetupPluginsById.get(id) ?? void 0;
	if (loadContext.setupPluginLoadInProgressIds.has(id)) return;
	const entry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
	if (!entry) return;
	loadContext.setupPluginLoadInProgressIds.add(id);
	try {
		const plugin = entry.loadSetupPlugin();
		loadContext.lazySetupPluginsById.set(id, plugin);
		return plugin;
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, id);
		log.warn(`[channels] failed to load bundled channel setup ${id}: ${detail}`);
		loadContext.lazySetupPluginsById.set(id, null);
		return;
	} finally {
		loadContext.setupPluginLoadInProgressIds.delete(id);
	}
}
function getBundledChannelSetupSecretsForRoot(id, rootScope, loadContext) {
	if (loadContext.lazySetupSecretsById.has(id)) return loadContext.lazySetupSecretsById.get(id) ?? void 0;
	const entry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
	if (!entry) return;
	try {
		const secrets = entry.loadSetupSecrets?.() ?? getBundledChannelSetupPluginForRoot(id, rootScope, loadContext)?.secrets;
		loadContext.lazySetupSecretsById.set(id, secrets ?? null);
		return secrets;
	} catch (error) {
		const detail = describeBundledChannelLoadError(error, id);
		log.warn(`[channels] failed to load bundled channel setup secrets ${id}: ${detail}`);
		loadContext.lazySetupSecretsById.set(id, null);
		return;
	}
}
function listBundledChannelPlugins() {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
		const plugin = getBundledChannelPluginForRoot(id, rootScope, loadContext);
		return plugin ? [plugin] : [];
	});
}
function listBundledChannelSetupPlugins() {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
		const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
		return plugin ? [plugin] : [];
	});
}
function listBundledChannelLegacySessionSurfaces(options = {}) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return listBundledChannelPluginIdsForSetupFeature(rootScope, "legacySessionSurfaces", { config: options.config }).flatMap((id) => {
		const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
		const surface = setupEntry?.loadLegacySessionSurface?.();
		if (surface) return [surface];
		if (!hasSetupEntryFeature(setupEntry, "legacySessionSurfaces")) return [];
		const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
		return plugin?.messaging ? [plugin.messaging] : [];
	});
}
function listBundledChannelLegacyStateMigrationDetectors(options = {}) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return listBundledChannelPluginIdsForSetupFeature(rootScope, "legacyStateMigrations", { config: options.config }).flatMap((id) => {
		const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
		const detector = setupEntry?.loadLegacyStateMigrationDetector?.();
		if (detector) return [detector];
		if (!hasSetupEntryFeature(setupEntry, "legacyStateMigrations")) return [];
		const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
		return plugin?.lifecycle?.detectLegacyStateMigrations ? [plugin.lifecycle.detectLegacyStateMigrations] : [];
	});
}
function getBundledChannelAccountInspector(id) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return getBundledChannelAccountInspectorForRoot(id, rootScope, loadContext);
}
function getBundledChannelPlugin(id) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return getBundledChannelPluginForRoot(id, rootScope, loadContext);
}
function getBundledChannelSecrets(id) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	return getBundledChannelSecretsForRoot(id, rootScope, loadContext);
}
function getBundledChannelSetupPlugin(id, env = process.env) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope(env);
	return getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
}
function getBundledChannelSetupSecrets(id, env = process.env) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope(env);
	return getBundledChannelSetupSecretsForRoot(id, rootScope, loadContext);
}
function setBundledChannelRuntime(id, runtime) {
	const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
	const setter = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry.setChannelRuntime;
	if (!setter) throw new Error(`missing bundled channel runtime setter: ${id}`);
	setter(runtime);
}
//#endregion
export { resolveExistingPluginModulePath as _, getBundledChannelSetupPlugin as a, listBundledChannelLegacySessionSurfaces as c, listBundledChannelPlugins as d, listBundledChannelSetupPlugins as f, loadChannelPluginModule as g, resolveBundledChannelRootScope as h, getBundledChannelSecrets as i, listBundledChannelLegacyStateMigrationDetectors as l, normalizeChannelMeta as m, getBundledChannelAccountInspector as n, getBundledChannelSetupSecrets as o, setBundledChannelRuntime as p, getBundledChannelPlugin as r, hasBundledChannelPackageSetupFeature as s, describeBundledChannelLoadError as t, listBundledChannelPluginIds as u };
