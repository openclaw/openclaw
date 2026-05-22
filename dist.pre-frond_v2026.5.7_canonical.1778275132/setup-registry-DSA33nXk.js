import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-Cut-MFnk.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
import { n as getCachedPluginModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-B60-0Kx3.js";
import { t as buildPluginApi } from "./api-builder-ngUrqxn2.js";
import { t as collectPluginConfigContractMatches } from "./config-contracts-B8EUdyU_.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/setup-descriptors.ts
function listSetupProviderIds(record) {
	return record.setup?.providers?.map((entry) => entry.id) ?? record.providers;
}
function listSetupCliBackendIds(record) {
	return record.setup?.cliBackends ?? record.cliBackends;
}
//#endregion
//#region src/plugins/setup-registry.ts
const SETUP_API_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts"
];
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) || CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const EMPTY_RUNTIME = {};
const NOOP_LOGGER = {
	info() {},
	warn() {},
	error() {}
};
const moduleLoaders = createPluginModuleLoaderCache();
function clearPluginSetupRegistryCache() {
	moduleLoaders.clear();
}
function getModuleLoader(modulePath) {
	return getCachedPluginModuleLoader({
		cache: moduleLoaders,
		modulePath,
		importerUrl: import.meta.url
	});
}
function resolveSetupApiPath(rootDir, options) {
	const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT ? SETUP_API_EXTENSIONS : [...SETUP_API_EXTENSIONS.slice(3), ...SETUP_API_EXTENSIONS.slice(0, 3)];
	const findSetupApi = (candidateRootDir) => {
		for (const extension of orderedExtensions) {
			const candidate = path.join(candidateRootDir, `setup-api${extension}`);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	};
	const direct = findSetupApi(rootDir);
	if (direct) return direct;
	if (options?.includeBundledSourceFallback === false) return null;
	const bundledExtensionDir = path.basename(rootDir);
	const repoRootCandidates = [path.resolve(path.dirname(CURRENT_MODULE_PATH), "..", "..")];
	for (const repoRoot of repoRootCandidates) {
		const sourceExtensionRoot = path.join(repoRoot, "extensions", bundledExtensionDir);
		if (sourceExtensionRoot === rootDir) continue;
		const sourceFallback = findSetupApi(sourceExtensionRoot);
		if (sourceFallback) return sourceFallback;
	}
	return null;
}
function collectConfiguredPluginEntryIds(config) {
	const entries = config.plugins?.entries;
	if (!entries || typeof entries !== "object") return [];
	return Object.keys(entries).map((pluginId) => pluginId.trim()).filter(Boolean).toSorted();
}
function resolveRelevantSetupMigrationPluginIds(params) {
	const ids = new Set(collectConfiguredPluginEntryIds(params.config));
	const registry = loadSetupManifestRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	for (const plugin of registry.plugins) {
		const paths = plugin.configContracts?.compatibilityMigrationPaths;
		if (!paths?.length) continue;
		if (paths.some((pathPattern) => collectPluginConfigContractMatches({
			root: params.config,
			pathPattern
		}).length > 0)) ids.add(plugin.id);
	}
	return [...ids].toSorted();
}
function resolveRegister(mod) {
	if (typeof mod === "function") return { register: mod };
	if (mod && typeof mod === "object" && typeof mod.register === "function") return {
		definition: mod,
		register: mod.register.bind(mod)
	};
	return {};
}
function resolveLoadableSetupRuntimeSource(record) {
	return record.setupSource ?? resolveSetupApiPath(record.rootDir);
}
function resolveDeclaredSetupRuntimeSource(record) {
	return record.setupSource ?? resolveSetupApiPath(record.rootDir, { includeBundledSourceFallback: false });
}
function resolveSetupRegistration(record) {
	if (record.setup?.requiresRuntime === false) return null;
	const setupSource = resolveLoadableSetupRuntimeSource(record);
	if (!setupSource) return null;
	let mod;
	try {
		mod = getModuleLoader(setupSource)(setupSource);
	} catch {
		return null;
	}
	const resolved = resolveRegister(mod.default ?? mod);
	if (!resolved.register) return null;
	if (resolved.definition?.id && resolved.definition.id !== record.id) return null;
	return {
		setupSource,
		register: resolved.register
	};
}
function buildSetupPluginApi(params) {
	return buildPluginApi({
		id: params.record.id,
		name: params.record.name ?? params.record.id,
		version: params.record.version,
		description: params.record.description,
		source: params.setupSource,
		rootDir: params.record.rootDir,
		registrationMode: "setup-only",
		config: {},
		runtime: EMPTY_RUNTIME,
		logger: NOOP_LOGGER,
		resolvePath: (input) => input,
		handlers: params.handlers
	});
}
function ignoreAsyncSetupRegisterResult(result) {
	if (!result || typeof result.then !== "function") return;
	Promise.resolve(result).catch(() => void 0);
}
function matchesProvider(provider, providerId) {
	const normalized = normalizeProviderId(providerId);
	if (normalizeProviderId(provider.id) === normalized) return true;
	return [...provider.aliases ?? [], ...provider.hookAliases ?? []].some((alias) => normalizeProviderId(alias) === normalized);
}
function loadSetupManifestRegistry(params) {
	const env = params?.env ?? process.env;
	return loadPluginManifestRegistryForPluginRegistry({
		config: params?.config,
		workspaceDir: params?.workspaceDir,
		env,
		pluginIds: params?.pluginIds,
		includeDisabled: true
	});
}
function findUniqueSetupManifestOwner(params) {
	const matches = params.registry.plugins.filter((entry) => params.listIds(entry).some((id) => normalizeProviderId(id) === params.normalizedId));
	if (matches.length === 0) return;
	return matches.length === 1 ? matches[0] : void 0;
}
function mapNormalizedIds(ids) {
	const mapped = /* @__PURE__ */ new Map();
	for (const id of ids) {
		const normalized = normalizeProviderId(id);
		if (!normalized || mapped.has(normalized)) continue;
		mapped.set(normalized, id);
	}
	return mapped;
}
function pushDescriptorRuntimeDisabledDiagnostic(params) {
	if (!resolveDeclaredSetupRuntimeSource(params.record)) return;
	params.diagnostics.push({
		pluginId: params.record.id,
		code: "setup-descriptor-runtime-disabled",
		message: "setup.requiresRuntime is false, so OpenClaw ignored the plugin setup runtime entry. Remove setup-api/openclaw.setupEntry or set requiresRuntime true if setup lookup still needs plugin code."
	});
}
function pushSetupDescriptorDriftDiagnostics(params) {
	const declaredProviderIds = params.record.setup?.providers?.map((entry) => entry.id);
	if (declaredProviderIds) {
		for (const declaredId of declaredProviderIds) if (!params.providers.some((provider) => matchesProvider(provider, declaredId))) params.diagnostics.push({
			pluginId: params.record.id,
			code: "setup-descriptor-provider-missing-runtime",
			declaredId,
			message: `setup.providers declares "${declaredId}" but setup runtime did not register a matching provider.`
		});
		for (const provider of params.providers) if (!declaredProviderIds.some((declaredId) => matchesProvider(provider, declaredId))) params.diagnostics.push({
			pluginId: params.record.id,
			code: "setup-descriptor-provider-runtime-undeclared",
			runtimeId: provider.id,
			message: `setup runtime registered provider "${provider.id}" but setup.providers does not declare it.`
		});
	}
	const declaredCliBackendIds = params.record.setup?.cliBackends;
	if (declaredCliBackendIds) {
		const declaredCliBackends = mapNormalizedIds(declaredCliBackendIds);
		const runtimeCliBackends = mapNormalizedIds(params.cliBackends.map((backend) => backend.id));
		for (const [normalized, declaredId] of declaredCliBackends) if (!runtimeCliBackends.has(normalized)) params.diagnostics.push({
			pluginId: params.record.id,
			code: "setup-descriptor-cli-backend-missing-runtime",
			declaredId,
			message: `setup.cliBackends declares "${declaredId}" but setup runtime did not register a matching CLI backend.`
		});
		for (const [normalized, runtimeId] of runtimeCliBackends) if (!declaredCliBackends.has(normalized)) params.diagnostics.push({
			pluginId: params.record.id,
			code: "setup-descriptor-cli-backend-runtime-undeclared",
			runtimeId,
			message: `setup runtime registered CLI backend "${runtimeId}" but setup.cliBackends does not declare it.`
		});
	}
}
function resolvePluginSetupRegistry(params) {
	const env = params?.env ?? process.env;
	const scopedPluginIds = params?.pluginIds ? new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean)) : null;
	if (scopedPluginIds && scopedPluginIds.size === 0) return {
		providers: [],
		cliBackends: [],
		configMigrations: [],
		autoEnableProbes: [],
		diagnostics: []
	};
	const providers = [];
	const cliBackends = [];
	const configMigrations = [];
	const autoEnableProbes = [];
	const diagnostics = [];
	const providerKeys = /* @__PURE__ */ new Set();
	const cliBackendKeys = /* @__PURE__ */ new Set();
	const manifestRegistry = params?.manifestRegistry ?? loadSetupManifestRegistry({
		config: params?.config,
		workspaceDir: params?.workspaceDir,
		env,
		pluginIds: params?.pluginIds
	});
	for (const record of manifestRegistry.plugins) {
		if (scopedPluginIds && !scopedPluginIds.has(record.id)) continue;
		if (record.setup?.requiresRuntime === false) {
			pushDescriptorRuntimeDisabledDiagnostic({
				record,
				diagnostics
			});
			continue;
		}
		const setupRegistration = resolveSetupRegistration(record);
		if (!setupRegistration) continue;
		const recordProviders = [];
		const recordCliBackends = [];
		const api = buildSetupPluginApi({
			record,
			setupSource: setupRegistration.setupSource,
			handlers: {
				registerProvider(provider) {
					const key = `${record.id}:${normalizeProviderId(provider.id)}`;
					if (providerKeys.has(key)) return;
					providerKeys.add(key);
					providers.push({
						pluginId: record.id,
						provider
					});
					recordProviders.push(provider);
				},
				registerCliBackend(backend) {
					const key = `${record.id}:${normalizeProviderId(backend.id)}`;
					if (cliBackendKeys.has(key)) return;
					cliBackendKeys.add(key);
					cliBackends.push({
						pluginId: record.id,
						backend
					});
					recordCliBackends.push(backend);
				},
				registerConfigMigration(migrate) {
					configMigrations.push({
						pluginId: record.id,
						migrate
					});
				},
				registerAutoEnableProbe(probe) {
					autoEnableProbes.push({
						pluginId: record.id,
						probe
					});
				}
			}
		});
		try {
			const result = setupRegistration.register(api);
			if (result && typeof result.then === "function") ignoreAsyncSetupRegisterResult(result);
		} catch {
			continue;
		}
		pushSetupDescriptorDriftDiagnostics({
			record,
			providers: recordProviders,
			cliBackends: recordCliBackends,
			diagnostics
		});
	}
	return {
		providers,
		cliBackends,
		configMigrations,
		autoEnableProbes,
		diagnostics
	};
}
function resolvePluginSetupProvider(params) {
	const env = params.env ?? process.env;
	const normalizedProvider = normalizeProviderId(params.provider);
	const record = findUniqueSetupManifestOwner({
		registry: loadSetupManifestRegistry({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env,
			pluginIds: params.pluginIds
		}),
		normalizedId: normalizedProvider,
		listIds: listSetupProviderIds
	});
	if (!record) return;
	const setupRegistration = resolveSetupRegistration(record);
	if (!setupRegistration) return;
	let matchedProvider;
	const localProviderKeys = /* @__PURE__ */ new Set();
	const api = buildSetupPluginApi({
		record,
		setupSource: setupRegistration.setupSource,
		handlers: {
			registerProvider(provider) {
				const key = normalizeProviderId(provider.id);
				if (localProviderKeys.has(key)) return;
				localProviderKeys.add(key);
				if (matchesProvider(provider, normalizedProvider)) matchedProvider = provider;
			},
			registerConfigMigration() {},
			registerAutoEnableProbe() {}
		}
	});
	try {
		const result = setupRegistration.register(api);
		if (result && typeof result.then === "function") ignoreAsyncSetupRegisterResult(result);
	} catch {
		return;
	}
	return matchedProvider;
}
function resolvePluginSetupCliBackend(params) {
	const normalized = normalizeProviderId(params.backend);
	const env = params.env ?? process.env;
	const record = findUniqueSetupManifestOwner({
		registry: loadSetupManifestRegistry({
			config: params.config,
			workspaceDir: params.workspaceDir,
			env
		}),
		normalizedId: normalized,
		listIds: listSetupCliBackendIds
	});
	if (!record) return;
	const setupRegistration = resolveSetupRegistration(record);
	if (!setupRegistration) return;
	let matchedBackend;
	const localBackendKeys = /* @__PURE__ */ new Set();
	const api = buildSetupPluginApi({
		record,
		setupSource: setupRegistration.setupSource,
		handlers: {
			registerProvider() {},
			registerConfigMigration() {},
			registerAutoEnableProbe() {},
			registerCliBackend(backend) {
				const key = normalizeProviderId(backend.id);
				if (localBackendKeys.has(key)) return;
				localBackendKeys.add(key);
				if (key === normalized) matchedBackend = backend;
			}
		}
	});
	try {
		const result = setupRegistration.register(api);
		if (result && typeof result.then === "function") ignoreAsyncSetupRegisterResult(result);
	} catch {
		return;
	}
	return (matchedBackend ? {
		pluginId: record.id,
		backend: matchedBackend
	} : null) ?? void 0;
}
function runPluginSetupConfigMigrations(params) {
	let next = params.config;
	const changes = [];
	const pluginIds = resolveRelevantSetupMigrationPluginIds(params);
	if (pluginIds.length === 0) return {
		config: next,
		changes
	};
	for (const entry of resolvePluginSetupRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		pluginIds
	}).configMigrations) {
		const migration = entry.migrate(next);
		if (!migration || migration.changes.length === 0) continue;
		next = migration.config;
		changes.push(...migration.changes);
	}
	return {
		config: next,
		changes
	};
}
function resolvePluginSetupAutoEnableReasons(params) {
	const env = params.env ?? process.env;
	const reasons = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of resolvePluginSetupRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env,
		pluginIds: params.pluginIds,
		manifestRegistry: params.manifestRegistry
	}).autoEnableProbes) {
		const raw = entry.probe({
			config: params.config,
			env
		});
		const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
		for (const reason of values) {
			const normalized = reason.trim();
			if (!normalized) continue;
			const key = `${entry.pluginId}:${normalized}`;
			if (seen.has(key)) continue;
			seen.add(key);
			reasons.push({
				pluginId: entry.pluginId,
				reason: normalized
			});
		}
	}
	return reasons;
}
//#endregion
export { resolvePluginSetupRegistry as a, resolvePluginSetupProvider as i, resolvePluginSetupAutoEnableReasons as n, runPluginSetupConfigMigrations as o, resolvePluginSetupCliBackend as r, clearPluginSetupRegistryCache as t };
