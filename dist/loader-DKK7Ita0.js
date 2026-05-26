import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { T as sanitizeCommandDescriptorDescription, w as normalizeCommandDescriptorName } from "./argv-j42r4Rb7.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { f as safeRealpathSync, i as isPathInside, p as safeStatSync } from "./path-BlG8lhgR.js";
import { f as shouldRejectHardlinkedPluginFiles, t as discoverOpenClawPlugins } from "./discovery-GEDtU7uI.js";
import { i as openRootFileSync } from "./root-file-jRMCpJW4.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { l as normalizeTrimmedStringList } from "./string-normalization-DiPHgdft.js";
import "./boundary-file-read-CBe_wA_B.js";
import "./bundle-manifest-s4nKSc4m.js";
import { _ as getPluginCompatRecord, p as collectPluginManifestCompatCodes } from "./installed-plugin-index-store-C1Oen9wR.js";
import { h as writeJsonSync, p as tryReadJsonSync } from "./json-files-C2hqjU--.js";
import { i as kindsEqual, n as defaultSlotIdForKey, r as hasKind } from "./slots-DT22cOei.js";
import { c as resolveEffectiveEnableState, d as resolveMemorySlotDecision, l as resolveEffectivePluginActivationState, n as createPluginActivationSource, s as normalizePluginsConfig, t as applyTestPluginDefaults } from "./config-state-CjJBf8PG.js";
import { n as loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { t as isPluginEnabledByDefaultForPlatform } from "./default-enablement-CT7_t1ee.js";
import { t as PluginLruCache } from "./plugin-cache-primitives-DcK62VYf.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Cy1cBr1u.js";
import { C as fingerprintPluginDiscoveryContext, T as resolvePluginDiscoveryContext } from "./plugin-registry-CgH_ZSlH.js";
import { n as getCachedPluginModuleLoader, s as toSafeImportPath, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-D0U0PNnl.js";
import { a as listPluginSdkAliasCandidates, c as resolveExtensionApiAlias, f as resolvePluginRuntimeModulePath, g as shouldPreferNativeModuleLoad, h as resolvePluginSdkScopedAliasMap, m as resolvePluginSdkAliasFile, n as buildPluginLoaderJitiOptions, o as listPluginSdkExportedSubpaths, p as resolvePluginSdkAliasCandidateOrder, t as buildPluginLoaderAliasMap } from "./sdk-alias-BqTLUqwL.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import "./installed-plugin-index-records-BrXfmg6n.js";
import { i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { t as validateJsonSchemaValue } from "./schema-validator-CoHaB3Uu.js";
import { n as listChatChannels } from "./chat-meta-2H4wOcrq.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { t as normalizePluginGatewayMethodScope } from "./gateway-method-policy-CwyGMC_n.js";
import "./core-descriptors-zcE5f_RQ.js";
import { s as isOperatorScope, t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
import { a as serializePluginIdScope, i as normalizePluginIdScope, n as hasExplicitPluginIdScope, t as createPluginIdScopeSet } from "./plugin-scope-6HF2N6kz.js";
import { m as normalizeChannelMeta } from "./bundled-0oTAwz0N.js";
import { t as unwrapDefaultModuleExport } from "./module-export-COvD9dVR.js";
import { t as attachPluginApiFacades } from "./api-facades-BqeVKWB0.js";
import { t as buildPluginApi } from "./api-builder-CbLcX7eD.js";
import { a as listRegisteredAgentHarnesses, c as restoreRegisteredAgentHarnesses, o as registerAgentHarness, r as getRegisteredAgentHarness, t as clearAgentHarnesses } from "./registry-BiKIFOzv.js";
import { G as resolveMemoryDreamingConfig, K as resolveMemoryDreamingPluginConfig, _ as DEFAULT_MEMORY_DREAMING_PLUGIN_ID } from "./dreaming-CxCxWYoC.js";
import { a as restoreDetachedTaskLifecycleRuntimeRegistration, i as registerDetachedTaskLifecycleRuntime, n as getDetachedTaskLifecycleRuntimeRegistration, t as clearDetachedTaskLifecycleRuntimeRegistration } from "./detached-task-runtime-state-B0mh7AbV.js";
import { n as inspectBundleMcpRuntimeSupport } from "./bundle-mcp-CrALtTOT.js";
import { A as listRegisteredPluginCommands, D as clearPluginCommandsForPlugin, E as clearPluginCommands, M as restorePluginCommands, S as restorePluginInteractiveHandlers, _ as clearPluginInteractiveHandlers, b as registerPluginInteractiveHandler, f as isConversationHookName, g as stripPromptMutationFieldsFromLegacyHookResult, i as registerPluginCommand, j as pluginCommands, m as isPromptInjectionHookName, o as validatePluginCommandDefinition, p as isPluginHookName, t as isReservedCommandName, v as clearPluginInteractiveHandlersForPlugin, y as listPluginInteractiveHandlers } from "./command-registration-io1ALI_N.js";
import { i as initializeGlobalHookRunner, t as getGlobalHookRunner } from "./hook-runner-global-BkXXy1ub.js";
import { a as resolveSetupChannelRegistration, i as resolveBundledRuntimeChannelRegistration, n as loadBundledRuntimeChannelPlugin, o as shouldLoadChannelPluginInSetupRuntime, r as mergeSetupRuntimeChannelPlugin, t as channelPluginIdBelongsToManifest } from "./loader-channel-setup-BDSdQdHL.js";
import { a as listRegisteredMemoryEmbeddingProviders, o as registerMemoryEmbeddingProvider, r as getRegisteredMemoryEmbeddingProvider, s as restoreRegisteredMemoryEmbeddingProviders, t as clearMemoryEmbeddingProviders } from "./memory-embedding-providers-816TTVuI.js";
import { S as restoreMemoryPluginState, _ as registerMemoryPromptSupplement, d as registerMemoryCapability, f as registerMemoryCorpusSupplement, g as registerMemoryPromptSectionForPlugin, l as listMemoryCorpusSupplements, m as registerMemoryFlushPlanResolverForPlugin, n as clearMemoryPluginState, r as getMemoryCapabilityRegistration, u as listMemoryPromptSupplements, y as registerMemoryRuntimeForPlugin } from "./memory-state-DKjCVvl8.js";
import { i as withProfile } from "./plugin-load-profile-DOnG9jJ5.js";
import { A as registerPluginSessionSchedulerJob, C as isPluginRegistryRetired, D as getPluginRunContext, E as deletePluginSessionSchedulerJob, F as createEmptyPluginRegistry, N as buildPluginAgentTurnPrepareContext, O as getPluginSessionSchedulerJobGeneration, P as normalizePluginHostHookId, S as isPluginRegistryActivated, T as clearPluginRunContext, a as getActivePluginRegistry, j as setPluginRunContext, l as getActivePluginRuntimeSubagentMode, o as getActivePluginRegistryKey, p as recordImportedPluginId, x as setActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { i as registerContextEngineForOwner, t as clearContextEnginesForOwner } from "./registry-DxH_0Os-.js";
import { f as registerInternalHook, h as unregisterInternalHook } from "./internal-hooks-DpfQDjis.js";
import { i as NODE_SYSTEM_RUN_COMMANDS, n as NODE_EXEC_APPROVALS_COMMANDS, r as NODE_SYSTEM_NOTIFY_COMMAND } from "./node-commands-SnI8Vs7F.js";
import { t as createPluginStateKeyedStore } from "./plugin-state-store-BqBrqTkQ.js";
import { i as emitAgentEvent } from "./agent-events-BuYtWSh4.js";
import { t as isPluginJsonValue } from "./host-hook-json-BHsxXV1L.js";
import { a as normalizeAgentToolResultMiddlewareRuntimeIds, n as normalizePluginToolContractNames, o as normalizeAgentToolResultMiddlewareRuntimes, r as normalizePluginToolNames, t as findUndeclaredPluginToolNames } from "./tool-contracts-CbE_6nZb.js";
import { n as resolveWorkspaceRoot, r as resolvePathFromInput } from "./workspace-dir-DICx6sb6.js";
import { n as resolveAgentMainSessionKey } from "./main-session-D3q_5w0B.js";
import { a as resolveSessionStoreKey, i as resolveSessionStoreAgentId } from "./combined-store-gateway-NV2GSCR6.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { l as normalizeSessionEntrySlotKey, t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { i as resolveAllAgentSessionStoreTargetsSync } from "./targets-B5o7Ubgb.js";
import { u as extractDeliveryInfo } from "./sessions-CQHHcgC_.js";
import { n as detectMime, t as FILE_TYPE_SNIFF_MAX_BYTES, u as normalizeMimeType } from "./mime-DppuT-pZ.js";
import "./host-hook-cleanup-4NNJkg8Y.js";
import { n as normalizePluginHttpPath, t as findOverlappingPluginHttpRoute } from "./http-route-overlap-BShPdT8Q.js";
import { i as withPluginRuntimePluginScope, r as withPluginRuntimePluginIdScope } from "./gateway-request-scope-B9qYB9tg.js";
import { t as encodeStartupTraceSegment } from "./startup-trace-segment-Cd4cVDJE.js";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import * as fsPromises from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
//#region src/plugins/activation-source-config.ts
function resolvePluginActivationSourceConfig(params) {
	if (params.activationSourceConfig !== void 0) return params.activationSourceConfig;
	const sourceSnapshot = getRuntimeConfigSourceSnapshot();
	if (sourceSnapshot && params.config === getRuntimeConfigSnapshot()) return sourceSnapshot;
	return params.config ?? {};
}
//#endregion
//#region src/plugins/api-lifecycle.ts
const PLUGIN_API_METHOD_POLICIES = {
	emitAgentEvent: {
		phase: "runtime",
		lateCallable: true
	},
	sendSessionAttachment: {
		phase: "runtime",
		lateCallable: true
	},
	scheduleSessionTurn: {
		phase: "runtime",
		lateCallable: true
	},
	unscheduleSessionTurnsByTag: {
		phase: "runtime",
		lateCallable: true
	}
};
function getPluginApiMethodLifecyclePolicy(methodName) {
	return PLUGIN_API_METHOD_POLICIES[methodName];
}
function isLateCallablePluginApiMethod(methodName) {
	return getPluginApiMethodLifecyclePolicy(methodName)?.lateCallable === true;
}
//#endregion
//#region src/plugins/compaction-provider.ts
const COMPACTION_PROVIDER_REGISTRY_STATE = Symbol.for("openclaw.compactionProviderRegistryState");
function getCompactionProviderRegistryState() {
	const globalState = globalThis;
	if (!globalState[COMPACTION_PROVIDER_REGISTRY_STATE]) globalState[COMPACTION_PROVIDER_REGISTRY_STATE] = { providers: /* @__PURE__ */ new Map() };
	return globalState[COMPACTION_PROVIDER_REGISTRY_STATE];
}
/**
* Register a compaction provider implementation.
* Pass `ownerPluginId` so the loader can snapshot/restore correctly.
*/
function registerCompactionProvider(provider, options) {
	getCompactionProviderRegistryState().providers.set(provider.id, {
		provider,
		ownerPluginId: options?.ownerPluginId
	});
}
/** Return the provider for the given id, or undefined. */
function getCompactionProvider(id) {
	return getCompactionProviderRegistryState().providers.get(id)?.provider;
}
/** Return the registered entry (provider + owner) for the given id. */
function getRegisteredCompactionProvider(id) {
	return getCompactionProviderRegistryState().providers.get(id);
}
/** List all registered entries with owner metadata (for snapshot/restore). */
function listRegisteredCompactionProviders() {
	return Array.from(getCompactionProviderRegistryState().providers.values());
}
/** Clear all compaction providers. Used by clearPluginLoaderCache() and reload. */
function clearCompactionProviders() {
	getCompactionProviderRegistryState().providers.clear();
}
/** Restore from a snapshot, replacing all current entries. */
function restoreRegisteredCompactionProviders(entries) {
	const map = getCompactionProviderRegistryState().providers;
	map.clear();
	for (const entry of entries) map.set(entry.provider.id, entry);
}
//#endregion
//#region src/plugins/embedding-providers.ts
const EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.embeddingProviders");
function getEmbeddingProviders() {
	const globalStore = globalThis;
	const existing = globalStore[EMBEDDING_PROVIDERS_KEY];
	if (existing instanceof Map) return existing;
	const created = /* @__PURE__ */ new Map();
	globalStore[EMBEDDING_PROVIDERS_KEY] = created;
	return created;
}
function registerEmbeddingProvider(adapter, options) {
	getEmbeddingProviders().set(adapter.id, {
		adapter,
		ownerPluginId: options?.ownerPluginId
	});
}
function getRegisteredEmbeddingProvider(id) {
	return getEmbeddingProviders().get(id);
}
function listRegisteredEmbeddingProviders() {
	return Array.from(getEmbeddingProviders().values());
}
function restoreRegisteredEmbeddingProviders(entries) {
	getEmbeddingProviders().clear();
	for (const entry of entries) registerEmbeddingProvider(entry.adapter, { ownerPluginId: entry.ownerPluginId });
}
function clearEmbeddingProviders() {
	getEmbeddingProviders().clear();
}
//#endregion
//#region src/plugins/loader-cache-state.ts
var PluginLoadReentryError = class extends Error {
	constructor(cacheKey) {
		super(`plugin load reentry detected for cache key: ${cacheKey}`);
		this.name = "PluginLoadReentryError";
		this.cacheKey = cacheKey;
	}
};
var PluginLoaderCacheState = class {
	#registryCache;
	#inFlightLoads = /* @__PURE__ */ new Set();
	#openAllowlistWarningCache = /* @__PURE__ */ new Set();
	constructor(defaultMaxEntries) {
		this.#registryCache = new PluginLruCache(defaultMaxEntries);
	}
	get maxEntries() {
		return this.#registryCache.maxEntries;
	}
	setMaxEntriesForTest(value) {
		this.#registryCache.setMaxEntriesForTest(value);
	}
	clear() {
		this.#registryCache.clear();
		this.#inFlightLoads.clear();
		this.#openAllowlistWarningCache.clear();
	}
	clearCachedRegistries() {
		this.#registryCache.clear();
		this.#openAllowlistWarningCache.clear();
	}
	get(cacheKey) {
		return this.#registryCache.get(cacheKey);
	}
	set(cacheKey, state) {
		this.#registryCache.set(cacheKey, state);
	}
	isLoadInFlight(cacheKey) {
		return this.#inFlightLoads.has(cacheKey);
	}
	beginLoad(cacheKey) {
		if (this.#inFlightLoads.has(cacheKey)) throw new PluginLoadReentryError(cacheKey);
		this.#inFlightLoads.add(cacheKey);
	}
	finishLoad(cacheKey) {
		this.#inFlightLoads.delete(cacheKey);
	}
	hasOpenAllowlistWarning(cacheKey) {
		return this.#openAllowlistWarningCache.has(cacheKey);
	}
	recordOpenAllowlistWarning(cacheKey) {
		this.#openAllowlistWarningCache.add(cacheKey);
	}
};
//#endregion
//#region src/plugins/loader-provenance.ts
function createPathMatcher() {
	return {
		exact: /* @__PURE__ */ new Set(),
		dirs: []
	};
}
function addPathToMatcher(matcher, rawPath, env = process.env) {
	const trimmed = rawPath.trim();
	if (!trimmed) return;
	const resolved = resolveUserPath(trimmed, env);
	if (!resolved) return;
	const canonical = safeRealpathSync(resolved) ?? resolved;
	if (matcher.exact.has(canonical) || matcher.dirs.includes(canonical)) return;
	if (safeStatSync(canonical)?.isDirectory()) {
		matcher.dirs.push(canonical);
		return;
	}
	matcher.exact.add(canonical);
}
function matchesPathMatcher(matcher, sourcePath) {
	if (matcher.exact.has(sourcePath)) return true;
	return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}
function buildProvenanceIndex(params) {
	const loadPathMatcher = createPathMatcher();
	for (const loadPath of params.normalizedLoadPaths) addPathToMatcher(loadPathMatcher, loadPath, params.env);
	const installRules = /* @__PURE__ */ new Map();
	const installs = params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
	for (const [pluginId, install] of Object.entries(installs)) {
		const rule = {
			trackedWithoutPaths: false,
			matcher: createPathMatcher()
		};
		const trackedPaths = [install.installPath, install.sourcePath].map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry));
		if (trackedPaths.length === 0) rule.trackedWithoutPaths = true;
		else for (const trackedPath of trackedPaths) addPathToMatcher(rule.matcher, trackedPath, params.env);
		installRules.set(pluginId, rule);
	}
	return {
		loadPathMatcher,
		installRules
	};
}
function isTrackedByProvenance(params) {
	const sourcePath = resolveUserPath(params.source, params.env);
	const canonicalSourcePath = safeRealpathSync(sourcePath) ?? sourcePath;
	const installRule = params.index.installRules.get(params.pluginId);
	if (installRule) {
		if (installRule.trackedWithoutPaths) return true;
		if (matchesPathMatcher(installRule.matcher, canonicalSourcePath)) return true;
	}
	return matchesPathMatcher(params.index.loadPathMatcher, canonicalSourcePath);
}
function matchesExplicitInstallRule(params) {
	const sourcePath = resolveUserPath(params.source, params.env);
	const canonicalSourcePath = safeRealpathSync(sourcePath) ?? sourcePath;
	const installRule = params.index.installRules.get(params.pluginId);
	if (!installRule || installRule.trackedWithoutPaths) return false;
	return matchesPathMatcher(installRule.matcher, canonicalSourcePath);
}
function resolveCandidateDuplicateRank(params) {
	const pluginId = params.manifestByRoot.get(params.candidate.rootDir)?.id;
	const isExplicitInstall = params.candidate.origin === "global" && pluginId !== void 0 && matchesExplicitInstallRule({
		pluginId,
		source: params.candidate.source,
		index: params.provenance,
		env: params.env
	});
	if (params.candidate.origin === "config") return 0;
	if (params.candidate.origin === "global" && isExplicitInstall) return 1;
	if (params.candidate.origin === "bundled") return 2;
	if (params.candidate.origin === "workspace") return 3;
	return 4;
}
function compareDuplicateCandidateOrder(params) {
	const leftPluginId = params.manifestByRoot.get(params.left.rootDir)?.id;
	const rightPluginId = params.manifestByRoot.get(params.right.rootDir)?.id;
	if (!leftPluginId || leftPluginId !== rightPluginId) return 0;
	return resolveCandidateDuplicateRank({
		candidate: params.left,
		manifestByRoot: params.manifestByRoot,
		provenance: params.provenance,
		env: params.env
	}) - resolveCandidateDuplicateRank({
		candidate: params.right,
		manifestByRoot: params.manifestByRoot,
		provenance: params.provenance,
		env: params.env
	});
}
function warnWhenAllowlistIsOpen(params) {
	if (!params.emitWarning) return;
	if (!params.pluginsEnabled) return;
	if (params.allow.length > 0) return;
	const autoDiscoverable = params.discoverablePlugins.filter((entry) => entry.origin === "workspace" || entry.origin === "global");
	if (autoDiscoverable.length === 0) return;
	if (params.warningCache.hasOpenAllowlistWarning(params.warningCacheKey)) return;
	const preview = autoDiscoverable.slice(0, 6).map((entry) => `${entry.id} (${entry.source})`).join(", ");
	const extra = autoDiscoverable.length > 6 ? ` (+${autoDiscoverable.length - 6} more)` : "";
	params.warningCache.recordOpenAllowlistWarning(params.warningCacheKey);
	params.logger.warn(`[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`);
}
function warnAboutUntrackedLoadedPlugins(params) {
	const allowSet = new Set(params.allowlist);
	for (const plugin of params.registry.plugins) {
		if (plugin.status !== "loaded" || plugin.origin === "bundled") continue;
		if (allowSet.has(plugin.id)) continue;
		if (isTrackedByProvenance({
			pluginId: plugin.id,
			source: plugin.source,
			index: params.provenance,
			env: params.env
		})) continue;
		const message = "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
		params.registry.diagnostics.push({
			level: "warn",
			pluginId: plugin.id,
			source: plugin.source,
			message
		});
		if (params.emitWarning) params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
	}
}
//#endregion
//#region src/plugins/loader-records.ts
function createPluginRecord(params) {
	return {
		id: params.id,
		name: params.name ?? params.id,
		description: params.description,
		version: params.version,
		packageName: params.packageName,
		format: params.format ?? "openclaw",
		bundleFormat: params.bundleFormat,
		bundleCapabilities: params.bundleCapabilities,
		source: params.source,
		rootDir: params.rootDir,
		origin: params.origin,
		workspaceDir: params.workspaceDir,
		trustedOfficialInstall: params.trustedOfficialInstall,
		enabled: params.enabled,
		compat: params.compat,
		explicitlyEnabled: params.activationState?.explicitlyEnabled,
		activated: params.activationState?.activated,
		activationSource: params.activationState?.source,
		activationReason: params.activationState?.reason,
		syntheticAuthRefs: params.syntheticAuthRefs ?? [],
		status: params.enabled ? "loaded" : "disabled",
		toolNames: [],
		hookNames: [],
		channelIds: [...params.channelIds ?? []],
		cliBackendIds: [],
		providerIds: [...params.providerIds ?? []],
		embeddingProviderIds: [...params.contracts?.embeddingProviders ?? []],
		speechProviderIds: [...params.contracts?.speechProviders ?? []],
		realtimeTranscriptionProviderIds: [...params.contracts?.realtimeTranscriptionProviders ?? []],
		realtimeVoiceProviderIds: [...params.contracts?.realtimeVoiceProviders ?? []],
		mediaUnderstandingProviderIds: [...params.contracts?.mediaUnderstandingProviders ?? []],
		imageGenerationProviderIds: [...params.contracts?.imageGenerationProviders ?? []],
		videoGenerationProviderIds: [...params.contracts?.videoGenerationProviders ?? []],
		musicGenerationProviderIds: [...params.contracts?.musicGenerationProviders ?? []],
		webFetchProviderIds: [...params.contracts?.webFetchProviders ?? []],
		webSearchProviderIds: [...params.contracts?.webSearchProviders ?? []],
		migrationProviderIds: [...params.contracts?.migrationProviders ?? []],
		contextEngineIds: [],
		memoryEmbeddingProviderIds: [...params.contracts?.memoryEmbeddingProviders ?? []],
		agentHarnessIds: [],
		cliCommands: [],
		services: [],
		gatewayDiscoveryServiceIds: [],
		commands: [],
		httpRoutes: 0,
		hookCount: 0,
		configSchema: params.configSchema,
		configUiHints: void 0,
		configJsonSchema: void 0,
		contracts: params.contracts
	};
}
function markPluginActivationDisabled(record, reason) {
	record.activated = false;
	record.activationSource = "disabled";
	record.activationReason = reason;
}
function formatAutoEnabledActivationReason(reasons) {
	if (!reasons || reasons.length === 0) return;
	return reasons.join("; ");
}
function recordPluginError(params) {
	const errorText = process.env.OPENCLAW_PLUGIN_LOADER_DEBUG_STACKS === "1" && params.error instanceof Error && typeof params.error.stack === "string" ? params.error.stack : String(params.error);
	const deprecatedApiHint = errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function") ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes" : null;
	const displayError = deprecatedApiHint ? `${deprecatedApiHint} (${errorText})` : errorText;
	params.logger.error(`${params.logPrefix}${displayError}`);
	params.record.status = "error";
	params.record.error = displayError;
	params.record.failedAt = /* @__PURE__ */ new Date();
	params.record.failurePhase = params.phase;
	params.registry.plugins.push(params.record);
	params.seenIds.set(params.pluginId, params.origin);
	params.registry.diagnostics.push({
		level: "error",
		pluginId: params.record.id,
		source: params.record.source,
		message: `${params.diagnosticMessagePrefix}${displayError}`
	});
}
function formatPluginFailureSummary(failedPlugins) {
	const grouped = /* @__PURE__ */ new Map();
	for (const plugin of failedPlugins) {
		const phase = plugin.failurePhase ?? "load";
		const ids = grouped.get(phase);
		if (ids) {
			ids.push(plugin.id);
			continue;
		}
		grouped.set(phase, [plugin.id]);
	}
	return [...grouped.entries()].map(([phase, ids]) => `${phase}: ${ids.join(", ")}`).join("; ");
}
function isPluginLoadDebugEnabled(env) {
	const normalized = normalizeLowercaseStringOrEmpty(env.OPENCLAW_PLUGIN_LOAD_DEBUG);
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function describePluginModuleExportShape(value, label = "export", seen = /* @__PURE__ */ new Set()) {
	if (value === null) return [`${label}:null`];
	if (typeof value !== "object") return [`${label}:${typeof value}`];
	if (seen.has(value)) return [`${label}:circular`];
	seen.add(value);
	const record = value;
	const keys = Object.keys(record).toSorted();
	const visibleKeys = keys.slice(0, 8);
	const extraCount = keys.length - visibleKeys.length;
	const details = [`${label}:object keys=${visibleKeys.length > 0 ? `${visibleKeys.join(",")}${extraCount > 0 ? `,+${extraCount}` : ""}` : "none"}`];
	for (const key of [
		"default",
		"module",
		"register",
		"activate"
	]) if (Object.prototype.hasOwnProperty.call(record, key)) details.push(...describePluginModuleExportShape(record[key], `${label}.${key}`, seen));
	return details;
}
function formatMissingPluginRegisterError(moduleExport, env) {
	const message = "plugin export missing register/activate";
	if (!isPluginLoadDebugEnabled(env)) return message;
	return `${message} (module shape: ${describePluginModuleExportShape(moduleExport).join("; ")})`;
}
//#endregion
//#region src/plugins/plugin-sdk-dist-alias.ts
function writeRuntimeJsonFile(targetPath, value) {
	writeJsonSync(targetPath, value);
}
function writeRuntimeModuleWrapper(sourcePath, targetPath) {
	const relative = `./${path.relative(path.dirname(targetPath), sourcePath).split(path.sep).join("/")}`;
	const content = [`export * from ${JSON.stringify(relative)};`, ""].join("\n");
	try {
		if (fs.readFileSync(targetPath, "utf8") === content) return;
	} catch {}
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, content, "utf8");
}
function ensureOpenClawPluginSdkAlias(distRoot) {
	const pluginSdkDir = path.join(distRoot, "plugin-sdk");
	if (!fs.existsSync(pluginSdkDir)) return;
	const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
	const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
	writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
		name: "openclaw",
		type: "module",
		exports: {
			"./plugin-sdk": "./plugin-sdk/index.js",
			"./plugin-sdk/*": "./plugin-sdk/*.js"
		}
	});
	try {
		if (fs.existsSync(pluginSdkAliasDir) && !fs.lstatSync(pluginSdkAliasDir).isDirectory()) fs.rmSync(pluginSdkAliasDir, {
			recursive: true,
			force: true
		});
	} catch {}
	fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
	for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
		if (!entry.isFile() || path.extname(entry.name) !== ".js") continue;
		writeRuntimeModuleWrapper(path.join(pluginSdkDir, entry.name), path.join(pluginSdkAliasDir, entry.name));
	}
}
//#endregion
//#region src/plugins/plugin-sdk-native-resolver.ts
const moduleWithResolver = Module;
const nodeResolveFilenameProperty = "_resolveFilename";
const PLUGIN_SDK_PACKAGE_PREFIXES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"];
const pluginSdkNativeAliases = /* @__PURE__ */ new Map();
const allowedParentRoots = /* @__PURE__ */ new Set();
let installed = false;
let previousResolveFilename;
function resolveLoaderModulePath(options) {
	return options.modulePath ?? fileURLToPath(options.moduleUrl ?? import.meta.url);
}
function isPluginSdkAliasSpecifier(specifier) {
	return PLUGIN_SDK_PACKAGE_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}
function isNativeLoadableSdkTarget(targetPath) {
	switch (path.extname(targetPath)) {
		case ".cjs":
		case ".js":
		case ".mjs": return true;
		default: return false;
	}
}
function normalizePathForBoundary(candidate) {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}
function findNearestPackageRoot(modulePath) {
	let cursor = path.dirname(path.resolve(modulePath));
	for (let i = 0; i < 12; i += 1) {
		if (fs.existsSync(path.join(cursor, "package.json"))) return cursor;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return path.dirname(path.resolve(modulePath));
}
function addAllowedParentRoot(root) {
	allowedParentRoots.add(normalizePathForBoundary(root));
}
function registerAllowedParentRoots(options) {
	if (options.pluginModulePath) addAllowedParentRoot(findNearestPackageRoot(options.pluginModulePath));
	for (const root of options.allowedParentRoots ?? []) addAllowedParentRoot(root);
}
function isWithinRoot(candidate, root) {
	const relative = path.relative(root, normalizePathForBoundary(candidate));
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function canResolveForParent(parent) {
	const parentFilename = parent?.filename;
	if (!parentFilename || allowedParentRoots.size === 0) return false;
	return [...allowedParentRoots].some((root) => isWithinRoot(parentFilename, root));
}
function listPluginSdkNativeAliases(options) {
	const modulePath = resolveLoaderModulePath(options);
	return Object.entries(buildPluginLoaderAliasMap(modulePath, options.argv1 ?? process.argv[1], options.moduleUrl, "dist")).filter(([specifier]) => isPluginSdkAliasSpecifier(specifier)).filter(([, target]) => isNativeLoadableSdkTarget(target)).flatMap(([specifier, target]) => {
		if (specifier.endsWith(".js")) return [[specifier, target]];
		return [[specifier, target], [`${specifier}.js`, target]];
	});
}
function installResolver() {
	if (installed || !moduleWithResolver[nodeResolveFilenameProperty]) return;
	previousResolveFilename = moduleWithResolver[nodeResolveFilenameProperty];
	moduleWithResolver[nodeResolveFilenameProperty] = ((request, parent, isMain, options) => {
		const aliasTarget = pluginSdkNativeAliases.get(request);
		if (aliasTarget && canResolveForParent(parent)) return aliasTarget;
		return previousResolveFilename?.(request, parent, isMain, options) ?? request;
	});
	installed = true;
}
function installOpenClawPluginSdkNativeResolver(options = {}) {
	for (const [specifier, target] of listPluginSdkNativeAliases(options)) pluginSdkNativeAliases.set(specifier, target);
	registerAllowedParentRoots(options);
	installResolver();
	return [...pluginSdkNativeAliases.keys()].toSorted();
}
//#endregion
//#region src/gateway/methods/registry.ts
function normalizeMethodName(name) {
	return name.trim();
}
function normalizeDescriptor(input) {
	const name = normalizeMethodName(input.name);
	if (!name) throw new Error("gateway method descriptor name must not be empty");
	const normalizedScope = input.scope === "node" || input.scope === "dynamic" ? input.scope : input.owner.kind === "plugin" ? normalizePluginGatewayMethodScope(name, input.scope).scope : input.scope;
	if (!normalizedScope) throw new Error(`gateway method descriptor is missing a scope: ${name}`);
	return {
		...input,
		name,
		scope: normalizedScope,
		...input.startup === "unavailable-until-sidecars" ? { startup: "unavailable-until-sidecars" } : {},
		...input.controlPlaneWrite === true ? { controlPlaneWrite: true } : {},
		...input.advertise === false ? { advertise: false } : {}
	};
}
function createGatewayMethodRegistry(inputs) {
	const descriptors = inputs.map(normalizeDescriptor);
	const byName = /* @__PURE__ */ new Map();
	for (const descriptor of descriptors) {
		if (byName.has(descriptor.name)) throw new Error(`gateway method already registered: ${descriptor.name}`);
		byName.set(descriptor.name, descriptor);
	}
	return {
		getHandler: (name) => byName.get(name)?.handler,
		listMethods: () => descriptors.map((descriptor) => descriptor.name),
		listAdvertisedMethods: () => descriptors.filter((descriptor) => descriptor.advertise !== false).map((descriptor) => descriptor.name),
		getScope: (name) => byName.get(name)?.scope,
		isStartupUnavailable: (name) => byName.get(name)?.startup === "unavailable-until-sidecars",
		isControlPlaneWrite: (name) => byName.get(name)?.controlPlaneWrite === true,
		descriptors: () => descriptors
	};
}
function createGatewayMethodDescriptorsFromHandlers(params) {
	return Object.entries(params.handlers).map(([name, handler]) => {
		const scope = params.scopes?.[name] ?? params.defaultScope;
		if (!scope) throw new Error(`gateway method is missing a scope: ${name}`);
		return {
			name,
			handler,
			owner: params.owner,
			scope
		};
	});
}
function createPluginGatewayMethodDescriptor(params) {
	const normalizedScope = normalizePluginGatewayMethodScope(params.name, params.scope).scope;
	return {
		name: params.name,
		handler: params.handler,
		owner: {
			kind: "plugin",
			pluginId: params.pluginId
		},
		scope: normalizedScope ?? "operator.admin"
	};
}
function createPluginGatewayMethodDescriptors(registry) {
	const descriptors = registry.gatewayMethodDescriptors ?? [];
	if (descriptors.length > 0) return [...descriptors];
	return createGatewayMethodDescriptorsFromHandlers({
		handlers: registry.gatewayHandlers,
		owner: {
			kind: "plugin",
			pluginId: "unknown"
		},
		defaultScope: ADMIN_SCOPE
	});
}
//#endregion
//#region src/plugins/agent-event-emission.ts
const HOST_OWNED_AGENT_EVENT_STREAMS = new Set([
	"lifecycle",
	"tool",
	"assistant",
	"error",
	"item",
	"plan",
	"approval",
	"command_output",
	"patch",
	"compaction",
	"thinking",
	"model"
]);
function isPluginOwnedAgentEventStream(pluginId, stream) {
	return stream === pluginId || stream.startsWith(`${pluginId}.`);
}
function normalizePluginEventData(params) {
	if (params.data && typeof params.data === "object" && !Array.isArray(params.data)) return {
		...params.data,
		pluginId: params.pluginId,
		...params.pluginName ? { pluginName: params.pluginName } : {}
	};
	return {
		value: params.data,
		pluginId: params.pluginId,
		...params.pluginName ? { pluginName: params.pluginName } : {}
	};
}
function emitPluginAgentEvent(params) {
	const runId = normalizeOptionalString(params.event.runId);
	const sessionKey = normalizeOptionalString(params.event.sessionKey);
	const stream = normalizeOptionalString(params.event.stream);
	if (!runId || !stream) return {
		emitted: false,
		reason: "runId and stream are required"
	};
	if (!isPluginJsonValue(params.event.data)) return {
		emitted: false,
		reason: "event data must be JSON-compatible"
	};
	if (params.origin !== "bundled" && HOST_OWNED_AGENT_EVENT_STREAMS.has(stream)) return {
		emitted: false,
		reason: `stream ${stream} is reserved for bundled plugins`
	};
	if (params.origin !== "bundled" && !isPluginOwnedAgentEventStream(params.pluginId, stream)) return {
		emitted: false,
		reason: `stream ${stream} must be scoped to plugin ${params.pluginId}`
	};
	emitAgentEvent({
		runId,
		stream,
		...sessionKey ? { sessionKey } : {},
		data: normalizePluginEventData({
			pluginId: params.pluginId,
			pluginName: params.pluginName,
			data: params.event.data
		})
	});
	return {
		emitted: true,
		stream
	};
}
//#endregion
//#region src/plugins/validation-diagnostics.ts
function pushPluginValidationDiagnostic(params) {
	params.pushDiagnostic({
		level: params.level,
		pluginId: params.pluginId,
		source: params.source,
		message: params.message
	});
}
//#endregion
//#region src/plugins/channel-validation.ts
function resolveBundledChannelMeta(id) {
	return listChatChannels().find((meta) => meta?.id === id);
}
function collectMissingChannelMetaFields(meta) {
	const missing = [];
	if (!normalizeOptionalString(meta?.label)) missing.push("label");
	if (!normalizeOptionalString(meta?.selectionLabel)) missing.push("selectionLabel");
	if (!normalizeOptionalString(meta?.docsPath)) missing.push("docsPath");
	if (typeof meta?.blurb !== "string") missing.push("blurb");
	return missing;
}
function normalizeRegisteredChannelPlugin(params) {
	const id = normalizeOptionalString(params.plugin?.id) ?? normalizeStringifiedOptionalString(params.plugin?.id) ?? "";
	if (!id) {
		pushPluginValidationDiagnostic({
			level: "error",
			pluginId: params.pluginId,
			source: params.source,
			message: "channel registration missing id",
			pushDiagnostic: params.pushDiagnostic
		});
		return null;
	}
	if (typeof params.plugin.config?.listAccountIds !== "function" || typeof params.plugin.config?.resolveAccount !== "function") {
		pushPluginValidationDiagnostic({
			level: "error",
			pluginId: params.pluginId,
			source: params.source,
			message: `channel "${id}" registration missing required config helpers`,
			pushDiagnostic: params.pushDiagnostic
		});
		return null;
	}
	const rawMeta = params.plugin.meta;
	const rawMetaId = normalizeOptionalString(rawMeta?.id);
	if (rawMetaId && rawMetaId !== id) pushPluginValidationDiagnostic({
		level: "warn",
		pluginId: params.pluginId,
		source: params.source,
		message: `channel "${id}" meta.id mismatch ("${rawMetaId}"); using registered channel id`,
		pushDiagnostic: params.pushDiagnostic
	});
	const missingFields = collectMissingChannelMetaFields(rawMeta);
	if (missingFields.length > 0) pushPluginValidationDiagnostic({
		level: "warn",
		pluginId: params.pluginId,
		source: params.source,
		message: `channel "${id}" registered incomplete metadata; filled missing ${missingFields.join(", ")}`,
		pushDiagnostic: params.pushDiagnostic
	});
	return {
		...params.plugin,
		id,
		meta: normalizeChannelMeta({
			id,
			meta: rawMeta,
			existing: resolveBundledChannelMeta(id)
		})
	};
}
function listCodexAppServerExtensionFactories() {
	return getActivePluginRegistry()?.codexAppServerExtensionFactories?.map((entry) => entry.factory) ?? [];
}
//#endregion
//#region src/plugins/host-hook-attachments.ts
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const attachmentProbeFs = { open: (...args) => fsPromises.open(...args) };
const MAX_ATTACHMENT_FILES = 10;
let sendMessagePromise;
async function loadSendMessage() {
	sendMessagePromise ??= import("./message-oTt1u1XX.js").then((module) => module.sendMessage);
	return sendMessagePromise;
}
let getChannelPluginPromise;
async function loadGetChannelPlugin() {
	getChannelPluginPromise ??= import("./plugins-C54ejDC8.js").then((module) => module.getChannelPlugin);
	return getChannelPluginPromise;
}
function captionFormatToParseMode(captionFormat) {
	if (captionFormat === "html") return "HTML";
}
function escapeHtmlText(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function readMimeSniffBuffer(filePath, size) {
	let handle;
	try {
		handle = await attachmentProbeFs.open(filePath, "r");
		const length = Math.min(Math.max(0, size), FILE_TYPE_SNIFF_MAX_BYTES);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} catch (error) {
		return { error: `attachment file MIME read failed for ${filePath}: ${formatErrorMessage(error)}` };
	} finally {
		await handle?.close().catch(() => void 0);
	}
}
function resolveAttachmentDelivery(params) {
	const fallbackParseMode = captionFormatToParseMode(params.captionFormat);
	const channel = params.channel.trim().toLowerCase();
	if (channel === "telegram") {
		const hint = params.channelHints?.telegram;
		const parseMode = hint?.parseMode ?? (params.captionFormat === "plain" ? "HTML" : fallbackParseMode);
		const escapePlainHtmlCaption = params.captionFormat === "plain" && parseMode === "HTML";
		const forceDocumentMime = normalizeMimeType(hint?.forceDocumentMime);
		return {
			...parseMode ? { parseMode } : {},
			...escapePlainHtmlCaption ? { escapePlainHtmlCaption: true } : {},
			...hint?.disableNotification !== void 0 ? { disableNotification: hint.disableNotification } : {},
			...forceDocumentMime ? { forceDocumentMime } : {}
		};
	}
	if (channel === "discord") return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
	if (channel === "slack") {
		const hint = params.channelHints?.slack;
		const threadTs = normalizeOptionalString(hint?.threadTs);
		return {
			...fallbackParseMode ? { parseMode: fallbackParseMode } : {},
			...threadTs ? { threadTs } : {}
		};
	}
	return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
}
async function validateAttachmentFiles(files, maxBytes, options) {
	if (files.length > MAX_ATTACHMENT_FILES) return { error: `at most ${MAX_ATTACHMENT_FILES} attachment files are allowed` };
	const paths = [];
	let totalBytes = 0;
	for (const file of files) {
		if (!file || typeof file !== "object" || Array.isArray(file)) return { error: "attachment file entry must be an object" };
		const filePath = normalizeOptionalString(file.path);
		if (!filePath) return { error: "attachment file path is required" };
		const resolvedPath = resolveAttachmentFilePath({
			filePath,
			config: options?.config,
			sessionKey: options?.sessionKey
		});
		const info = await lstat(resolvedPath).catch(() => void 0);
		if (info?.isSymbolicLink()) return { error: `attachment file symlinks are not allowed: ${resolvedPath}` };
		if (!info?.isFile()) return { error: `attachment file not found: ${resolvedPath}` };
		if (info.size > maxBytes) return { error: `attachment file exceeds ${maxBytes} bytes: ${resolvedPath}` };
		if (options?.forceDocumentMime) {
			const fileBuffer = await readMimeSniffBuffer(resolvedPath, info.size);
			if (!Buffer.isBuffer(fileBuffer)) return fileBuffer;
			let detectedMime;
			try {
				detectedMime = normalizeMimeType(await detectMime({ buffer: fileBuffer }));
			} catch (error) {
				return { error: `attachment file MIME detection failed for ${filePath}: ` + formatErrorMessage(error) };
			}
			if (detectedMime !== options.forceDocumentMime) return { error: `attachment file MIME mismatch for ${resolvedPath}: expected ${options.forceDocumentMime}, got ${detectedMime ?? "unknown"}` };
		}
		totalBytes += info.size;
		if (totalBytes > maxBytes) return { error: `attachment files exceed ${maxBytes} bytes total` };
		paths.push(resolvedPath);
	}
	return paths;
}
function resolveAttachmentFilePath(params) {
	const workspaceDir = params.sessionKey && params.config ? resolveAgentWorkspaceDir(params.config, resolveAgentIdFromSessionKey(params.sessionKey)) : void 0;
	return resolvePathFromInput(params.filePath, resolveWorkspaceRoot(workspaceDir));
}
function normalizeOptionalThreadId(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return normalizeOptionalString(value);
}
function resolveSessionAttachmentThreadId(params) {
	return params.hintThreadTs ?? normalizeOptionalThreadId(params.explicitThreadId) ?? normalizeOptionalThreadId(params.fallbackThreadId) ?? normalizeOptionalThreadId(params.deliveryThreadId);
}
async function sendPluginSessionAttachment(params) {
	if (params.origin !== "bundled") return {
		ok: false,
		error: "session attachments are restricted to bundled plugins"
	};
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!sessionKey) return {
		ok: false,
		error: "sessionKey is required"
	};
	if (!Array.isArray(params.files) || params.files.length === 0) return {
		ok: false,
		error: "at least one attachment file is required"
	};
	const maxBytes = typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) ? Math.min(DEFAULT_ATTACHMENT_MAX_BYTES, Math.max(1, Math.floor(params.maxBytes))) : DEFAULT_ATTACHMENT_MAX_BYTES;
	const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.config });
	if (!deliveryContext?.channel || !deliveryContext.to) return {
		ok: false,
		error: `session has no active delivery route: ${sessionKey}`
	};
	const normalizedChannel = normalizeMessageChannel(deliveryContext.channel);
	try {
		if ((normalizedChannel && isDeliverableMessageChannel(normalizedChannel) ? (await loadGetChannelPlugin())(normalizedChannel) : void 0)?.outbound?.deliveryMode === "gateway") return {
			ok: false,
			error: `session attachments require direct outbound delivery for channel ${deliveryContext.channel}; channel uses gateway delivery`
		};
	} catch (error) {
		return {
			ok: false,
			error: `attachment delivery setup failed: ${formatErrorMessage(error)}`
		};
	}
	const rawText = normalizeOptionalString(params.text) ?? "";
	const resolvedDelivery = resolveAttachmentDelivery({
		channel: deliveryContext.channel,
		captionFormat: params.captionFormat,
		channelHints: params.channelHints
	});
	const validated = await validateAttachmentFiles(params.files, maxBytes, {
		forceDocumentMime: resolvedDelivery.forceDocumentMime,
		config: params.config,
		sessionKey
	});
	if (!Array.isArray(validated)) return {
		ok: false,
		error: validated.error
	};
	const resolvedThreadId = resolveSessionAttachmentThreadId({
		deliveryThreadId: deliveryContext.threadId,
		explicitThreadId: params.threadId,
		fallbackThreadId: threadId,
		hintThreadTs: resolvedDelivery.threadTs
	});
	let result;
	try {
		result = await (await loadSendMessage())({
			to: deliveryContext.to,
			content: resolvedDelivery.escapePlainHtmlCaption ? escapeHtmlText(rawText) : rawText,
			channel: deliveryContext.channel,
			accountId: deliveryContext.accountId,
			threadId: resolvedThreadId,
			requesterSessionKey: sessionKey,
			mediaUrls: validated,
			forceDocument: resolvedDelivery.forceDocumentMime ? true : params.forceDocument,
			bestEffort: false,
			cfg: params.config,
			...resolvedDelivery.parseMode ? { parseMode: resolvedDelivery.parseMode } : {},
			...resolvedDelivery.disableNotification !== void 0 ? { silent: resolvedDelivery.disableNotification } : {}
		});
	} catch (error) {
		return {
			ok: false,
			error: `attachment delivery failed: ${formatErrorMessage(error)}`
		};
	}
	if (!result.result) return {
		ok: false,
		error: "attachment delivery failed: no delivery result returned"
	};
	return {
		ok: true,
		channel: result.channel,
		deliveredTo: deliveryContext.to,
		count: validated.length
	};
}
//#endregion
//#region src/plugins/host-hook-scheduled-turns.ts
const log$1 = createSubsystemLogger("plugins/host-scheduled-turns");
const PLUGIN_CRON_NAME_PREFIX = "plugin:";
const PLUGIN_CRON_TAG_MARKER = ":tag:";
function resolveSchedule(params) {
	const cron = normalizeOptionalString(params.cron);
	if (cron) {
		const tz = normalizeOptionalString(params.tz);
		return {
			kind: "cron",
			expr: cron,
			...tz ? { tz } : {}
		};
	}
	if ("delayMs" in params) {
		if (!Number.isFinite(params.delayMs) || params.delayMs < 0) return;
		const timestamp = Date.now() + Math.max(1, Math.floor(params.delayMs));
		if (!Number.isFinite(timestamp)) return;
		const at = new Date(timestamp);
		if (!Number.isFinite(at.getTime())) return;
		return {
			kind: "at",
			at: at.toISOString()
		};
	}
	const rawAt = params.at;
	const at = rawAt instanceof Date ? rawAt : new Date(rawAt);
	if (!Number.isFinite(at.getTime())) return;
	return {
		kind: "at",
		at: at.toISOString()
	};
}
function resolveSessionEventDeliveryMode(deliveryMode) {
	if (deliveryMode === void 0) return;
	if (deliveryMode === "none" || deliveryMode === "announce") return deliveryMode;
}
function formatScheduleLogContext(params) {
	const parts = [`pluginId=${params.pluginId}`];
	if (params.sessionKey) parts.push(`sessionKey=${params.sessionKey}`);
	if (params.name) parts.push(`name=${params.name}`);
	if (params.jobId) parts.push(`jobId=${params.jobId}`);
	return parts.join(" ");
}
async function removeScheduledSessionTurn(params) {
	try {
		return didCronCleanupJob(await params.cron.remove(params.jobId));
	} catch (error) {
		log$1.warn(`plugin session turn cleanup failed (${formatScheduleLogContext(params)}): ${formatErrorMessage(error)}`);
		return false;
	}
}
function didCronRemoveJob(value) {
	return isCronRemoveResult(value) && value.ok && value.removed;
}
function didCronCleanupJob(value) {
	return isCronRemoveResult(value) && value.ok;
}
const PLUGIN_CRON_RESERVED_DELIMITER = ":";
function resolvePluginSessionTurnTag(value) {
	const tag = normalizeOptionalString(value);
	if (!tag) return { invalid: false };
	if (tag.includes(PLUGIN_CRON_RESERVED_DELIMITER)) return { invalid: true };
	return {
		tag,
		invalid: false
	};
}
function buildPluginSchedulerCronName(params) {
	const uniqueId = params.uniqueId ?? randomUUID();
	if (!params.tag) return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}:${params.sessionKey}:${uniqueId}`;
	return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:${uniqueId}`;
}
function buildPluginSchedulerTagPrefix(params) {
	return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:`;
}
function isCronRemoveResult(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof value.ok === "boolean" && typeof value.removed === "boolean";
}
async function listAllCronJobsForPluginTagCleanup(cron, query) {
	const jobs = [];
	let offset = 0;
	for (;;) {
		const listResult = await cron.listPage({
			includeDisabled: true,
			limit: 200,
			query,
			sortBy: "name",
			sortDir: "asc",
			...offset > 0 ? { offset } : {}
		});
		jobs.push(...listResult.jobs);
		if (!listResult.hasMore) return jobs;
		if (listResult.nextOffset === null || listResult.nextOffset <= offset) return jobs;
		offset = listResult.nextOffset;
	}
}
async function schedulePluginSessionTurn(params) {
	if (params.origin !== "bundled") return;
	const sessionKey = normalizeOptionalString(params.schedule.sessionKey);
	const message = normalizeOptionalString(params.schedule.message);
	if (!sessionKey || !message) return;
	const cronSchedule = resolveSchedule(params.schedule);
	if (!cronSchedule) return;
	const rawDeliveryMode = params.schedule.deliveryMode;
	const deliveryMode = resolveSessionEventDeliveryMode(rawDeliveryMode);
	const scheduleName = normalizeOptionalString(params.schedule.name);
	if (rawDeliveryMode !== void 0 && !deliveryMode) {
		log$1.warn(`plugin session turn scheduling failed (${formatScheduleLogContext({
			pluginId: params.pluginId,
			sessionKey,
			...scheduleName ? { name: scheduleName } : {}
		})}): unsupported deliveryMode`);
		return;
	}
	if (cronSchedule.kind === "cron" && params.schedule.deleteAfterRun === true) {
		log$1.warn(`plugin session turn scheduling failed (${formatScheduleLogContext({
			pluginId: params.pluginId,
			sessionKey,
			...scheduleName ? { name: scheduleName } : {}
		})}): deleteAfterRun requires a one-shot schedule`);
		return;
	}
	const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.schedule.tag);
	if (invalidTag) {
		log$1.warn(`plugin session turn scheduling failed (${formatScheduleLogContext({
			pluginId: params.pluginId,
			sessionKey,
			...scheduleName ? { name: scheduleName } : {}
		})}): tag contains reserved delimiter ":"`);
		return;
	}
	const cronDeliveryMode = deliveryMode ?? "announce";
	if (params.shouldCommit && !params.shouldCommit()) return;
	if (!params.cron) {
		log$1.warn(`plugin session turn scheduling failed (${formatScheduleLogContext({
			pluginId: params.pluginId,
			sessionKey,
			...scheduleName ? { name: scheduleName } : {}
		})}): cron service unavailable`);
		return;
	}
	const cron = params.cron;
	const cronJobName = buildPluginSchedulerCronName({
		pluginId: params.pluginId,
		sessionKey,
		...tag !== void 0 ? { tag } : {},
		...scheduleName ? { uniqueId: scheduleName } : {}
	});
	const cronPayload = {
		kind: "agentTurn",
		message
	};
	let result;
	try {
		result = await cron.add({
			name: cronJobName,
			enabled: true,
			schedule: cronSchedule,
			sessionTarget: `session:${sessionKey}`,
			payload: cronPayload,
			...params.schedule.agentId ? { agentId: params.schedule.agentId } : {},
			deleteAfterRun: params.schedule.deleteAfterRun ?? cronSchedule.kind === "at",
			wakeMode: "now",
			delivery: {
				mode: cronDeliveryMode,
				...cronDeliveryMode === "announce" ? { channel: "last" } : {}
			}
		});
	} catch (error) {
		log$1.warn(`plugin session turn scheduling failed (${formatScheduleLogContext({
			pluginId: params.pluginId,
			sessionKey,
			name: cronJobName
		})}): ${formatErrorMessage(error)}`);
		return;
	}
	const jobId = result.id;
	if (!jobId) return;
	if (params.shouldCommit && !params.shouldCommit()) {
		if (!await removeScheduledSessionTurn({
			cron,
			jobId,
			pluginId: params.pluginId,
			sessionKey,
			name: cronJobName
		})) log$1.warn(`plugin session turn scheduling rollback failed (${formatScheduleLogContext({
			pluginId: params.pluginId,
			sessionKey,
			name: cronJobName,
			jobId
		})}): failed to remove stale scheduled session turn`);
		return;
	}
	return registerPluginSessionSchedulerJob({
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		ownerRegistry: params.ownerRegistry,
		job: {
			id: jobId,
			sessionKey,
			kind: "session-turn",
			cleanup: async () => {
				if (!await removeScheduledSessionTurn({
					cron,
					jobId,
					pluginId: params.pluginId,
					sessionKey,
					name: cronJobName
				})) throw new Error(`failed to remove scheduled session turn: ${jobId}`);
			}
		}
	});
}
async function unschedulePluginSessionTurnsByTag(params) {
	if (params.origin !== "bundled") return {
		removed: 0,
		failed: 0
	};
	const sessionKey = normalizeOptionalString(params.request.sessionKey);
	const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.request.tag);
	if (!sessionKey || !tag || invalidTag) return {
		removed: 0,
		failed: 0
	};
	if (!params.cron) {
		log$1.warn("plugin session turn untag-list failed: cron service unavailable");
		return {
			removed: 0,
			failed: 1
		};
	}
	const cron = params.cron;
	const namePrefix = buildPluginSchedulerTagPrefix({
		pluginId: params.pluginId,
		tag,
		sessionKey
	});
	let jobs;
	try {
		jobs = await listAllCronJobsForPluginTagCleanup(cron, namePrefix);
	} catch (error) {
		log$1.warn(`plugin session turn untag-list failed: ${formatErrorMessage(error)}`);
		return {
			removed: 0,
			failed: 1
		};
	}
	const candidates = jobs.filter((job) => {
		return job.name.startsWith(namePrefix) && job.sessionTarget === `session:${sessionKey}`;
	});
	let removed = 0;
	let failed = 0;
	for (const job of candidates) {
		const id = job.id.trim();
		if (!id) continue;
		try {
			if (didCronRemoveJob(await cron.remove(id))) {
				removed += 1;
				deletePluginSessionSchedulerJob({
					pluginId: params.pluginId,
					jobId: id,
					sessionKey
				});
			} else failed += 1;
		} catch (error) {
			log$1.warn(`plugin session turn untag-remove failed: id=${id} error=${formatErrorMessage(error)}`);
			failed += 1;
		}
	}
	return {
		removed,
		failed
	};
}
//#endregion
//#region src/plugins/host-hook-state.ts
const log = createSubsystemLogger("plugins/host-hook-state");
const PROJECTION_FAILED = Symbol("plugin-session-extension-projection-failed");
const MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH = 32 * 1024;
const MAX_PLUGIN_NEXT_TURN_INJECTION_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION = 32;
function isStorePathTemplate(store) {
	return typeof store === "string" && store.includes("{agentId}");
}
function normalizeNamespace(value) {
	return value.trim();
}
function copyJsonValue(value) {
	return structuredClone(value);
}
function isPluginNextTurnInjectionPlacement(value) {
	return value === "prepend_context" || value === "append_context";
}
function isPluginNextTurnInjectionRecord(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.id === "string" && typeof candidate.pluginId === "string" && typeof candidate.text === "string" && typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt) && isPluginNextTurnInjectionPlacement(candidate.placement) && (candidate.ttlMs === void 0 || typeof candidate.ttlMs === "number" && Number.isFinite(candidate.ttlMs) && candidate.ttlMs >= 0) && (candidate.idempotencyKey === void 0 || typeof candidate.idempotencyKey === "string");
}
function isExpired(entry, now) {
	if (!isPluginNextTurnInjectionRecord(entry)) return true;
	return typeof entry.ttlMs === "number" && entry.ttlMs >= 0 && now - entry.createdAt > entry.ttlMs;
}
function findStoreKeysIgnoreCase(store, targetKey) {
	const lowered = normalizeLowercaseStringOrEmpty(targetKey);
	const matches = [];
	for (const key of Object.keys(store)) if (normalizeLowercaseStringOrEmpty(key) === lowered) matches.push(key);
	return matches;
}
function findFreshestStoreMatch(store, ...candidates) {
	let freshest;
	for (const candidate of candidates) {
		const trimmed = normalizeOptionalString(candidate) ?? "";
		if (!trimmed) continue;
		const exact = store[trimmed];
		if (exact && (!freshest || (exact.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) freshest = {
			entry: exact,
			key: trimmed
		};
		for (const legacyKey of findStoreKeysIgnoreCase(store, trimmed)) {
			const entry = store[legacyKey];
			if (entry && (!freshest || (entry.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) freshest = {
				entry,
				key: legacyKey
			};
		}
	}
	return freshest;
}
function resolveSessionStoreCandidates(params) {
	const storeConfig = params.cfg.session?.store;
	const defaultTarget = {
		agentId: params.agentId,
		storePath: resolveStorePath(storeConfig, { agentId: params.agentId })
	};
	if (!isStorePathTemplate(storeConfig)) return [defaultTarget];
	const targets = /* @__PURE__ */ new Map();
	targets.set(defaultTarget.storePath, defaultTarget);
	for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) if (target.agentId === params.agentId) targets.set(target.storePath, target);
	return [...targets.values()];
}
function buildSessionStoreScanTargets(params) {
	const targets = /* @__PURE__ */ new Set();
	if (params.canonicalKey) targets.add(params.canonicalKey);
	if (params.key && params.key !== params.canonicalKey) targets.add(params.key);
	if (params.canonicalKey === "global" || params.canonicalKey === "unknown") return [...targets];
	const agentMainKey = resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	});
	if (params.canonicalKey === agentMainKey) targets.add(`agent:${params.agentId}:main`);
	return [...targets];
}
function loadPluginHostHookSessionEntry(params) {
	const key = normalizeOptionalString(params.sessionKey) ?? "";
	const cfg = params.cfg;
	const canonicalKey = resolveSessionStoreKey({
		cfg,
		sessionKey: key
	});
	const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
	const scanTargets = buildSessionStoreScanTargets({
		cfg,
		key,
		canonicalKey,
		agentId
	});
	const candidates = resolveSessionStoreCandidates({
		cfg,
		agentId
	});
	const fallback = candidates[0] ?? {
		agentId,
		storePath: resolveStorePath(cfg.session?.store, { agentId })
	};
	let selectedStorePath = fallback.storePath;
	let selectedMatch = findFreshestStoreMatch(loadSessionStore(fallback.storePath), ...scanTargets);
	for (let index = 1; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const match = findFreshestStoreMatch(loadSessionStore(candidate.storePath), ...scanTargets);
		if (match && (!selectedMatch || (match.entry.updatedAt ?? 0) >= (selectedMatch.entry.updatedAt ?? 0))) {
			selectedStorePath = candidate.storePath;
			selectedMatch = match;
		}
	}
	return {
		storePath: selectedStorePath,
		entry: selectedMatch?.entry,
		canonicalKey,
		storeKey: selectedMatch?.key ?? canonicalKey
	};
}
function isPluginPromptInjectionEnabled(cfg, pluginId) {
	return (cfg.plugins?.entries?.[pluginId])?.hooks?.allowPromptInjection !== false;
}
function toPluginNextTurnInjectionRecord(params) {
	return {
		id: params.injection.idempotencyKey?.trim() || randomUUID(),
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		text: params.injection.text,
		idempotencyKey: params.injection.idempotencyKey?.trim() || void 0,
		placement: params.injection.placement ?? "prepend_context",
		ttlMs: params.injection.ttlMs,
		createdAt: params.now,
		metadata: params.injection.metadata
	};
}
async function enqueuePluginNextTurnInjection(params) {
	if (typeof params.injection.sessionKey !== "string") return {
		enqueued: false,
		id: "",
		sessionKey: ""
	};
	const sessionKey = params.injection.sessionKey.trim();
	if (!sessionKey) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	if (typeof params.injection.text !== "string") return {
		enqueued: false,
		id: "",
		sessionKey
	};
	const text = params.injection.text.trim();
	if (!text) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	if (text.length > MAX_PLUGIN_NEXT_TURN_INJECTION_TEXT_LENGTH) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	if (params.injection.metadata !== void 0 && !isPluginJsonValue(params.injection.metadata)) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	if (params.injection.idempotencyKey !== void 0 && (typeof params.injection.idempotencyKey !== "string" || params.injection.idempotencyKey.trim().length === 0 || params.injection.idempotencyKey.length > MAX_PLUGIN_NEXT_TURN_INJECTION_IDEMPOTENCY_KEY_LENGTH)) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	if (params.injection.placement !== void 0 && !isPluginNextTurnInjectionPlacement(params.injection.placement)) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	if (params.injection.ttlMs !== void 0 && (!Number.isFinite(params.injection.ttlMs) || params.injection.ttlMs < 0)) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	const loaded = loadPluginHostHookSessionEntry({
		cfg: params.cfg,
		sessionKey
	});
	if (!loaded.entry) return {
		enqueued: false,
		id: "",
		sessionKey
	};
	const canonicalKey = loaded.canonicalKey ?? sessionKey;
	const now = params.now ?? Date.now();
	const record = toPluginNextTurnInjectionRecord({
		pluginId: params.pluginId,
		pluginName: params.pluginName,
		injection: {
			...params.injection,
			sessionKey,
			text
		},
		now
	});
	let enqueued = false;
	let resultId = record.id;
	await updateSessionStore(loaded.storePath, (store) => {
		const entry = store[loaded.storeKey];
		if (!entry) return;
		const injections = { ...entry.pluginNextTurnInjections };
		const rawExisting = injections[params.pluginId];
		const existing = (Array.isArray(rawExisting) ? [...rawExisting] : []).filter((candidate) => !isExpired(candidate, now));
		const duplicate = record.idempotencyKey ? existing.find((candidate) => candidate.idempotencyKey === record.idempotencyKey) : void 0;
		if (duplicate) {
			resultId = duplicate.id;
			injections[params.pluginId] = existing;
			entry.pluginNextTurnInjections = injections;
			return;
		}
		if (existing.length >= MAX_PLUGIN_NEXT_TURN_INJECTIONS_PER_SESSION) {
			injections[params.pluginId] = existing;
			entry.pluginNextTurnInjections = injections;
			return;
		}
		injections[params.pluginId] = [...existing, record];
		entry.pluginNextTurnInjections = injections;
		entry.updatedAt = now;
		enqueued = true;
	});
	return {
		enqueued,
		id: resultId,
		sessionKey: canonicalKey
	};
}
async function drainPluginNextTurnInjections(params) {
	const sessionKey = params.sessionKey?.trim();
	if (!sessionKey) return [];
	const loaded = loadPluginHostHookSessionEntry({
		cfg: params.cfg,
		sessionKey
	});
	if (!loaded.entry) return [];
	if (!loaded.entry.pluginNextTurnInjections || Object.keys(loaded.entry.pluginNextTurnInjections).length === 0) return [];
	const now = params.now ?? Date.now();
	return await updateSessionStore(loaded.storePath, (store) => {
		const entry = store[loaded.storeKey];
		if (!entry?.pluginNextTurnInjections) return [];
		const activePluginIds = new Set((getActivePluginRegistry()?.plugins ?? []).filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id));
		const drained = [];
		for (const [pluginId, entries] of Object.entries(entry.pluginNextTurnInjections)) {
			if (!activePluginIds.has(pluginId) || !isPluginPromptInjectionEnabled(params.cfg, pluginId)) continue;
			if (!Array.isArray(entries)) continue;
			const liveEntries = entries.filter((candidate) => !isExpired(candidate, now));
			drained.push(...liveEntries);
		}
		drained.sort((left, right) => left.createdAt - right.createdAt);
		delete entry.pluginNextTurnInjections;
		if (drained.length > 0) entry.updatedAt = now;
		return drained;
	});
}
async function drainPluginNextTurnInjectionContext(params) {
	const queuedInjections = await drainPluginNextTurnInjections(params);
	return {
		queuedInjections,
		...buildPluginAgentTurnPrepareContext({ queuedInjections })
	};
}
function getPluginSessionExtensionStateSync(params) {
	const pluginId = params.pluginId.trim();
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!pluginId || !sessionKey) return;
	const value = loadPluginHostHookSessionEntry({
		cfg: params.cfg,
		sessionKey
	}).entry?.pluginExtensions?.[pluginId];
	return value ? copyJsonValue(value) : void 0;
}
async function patchPluginSessionExtension(params) {
	const namespace = normalizeNamespace(params.namespace);
	const pluginId = params.pluginId.trim();
	if (!pluginId || !namespace) return {
		ok: false,
		error: "pluginId and namespace are required"
	};
	if (params.unset === true && params.value !== void 0) return {
		ok: false,
		error: "plugin session extension cannot specify both unset and value"
	};
	if (params.value !== void 0 && !isPluginJsonValue(params.value)) return {
		ok: false,
		error: "plugin session extension value must be JSON-compatible"
	};
	if (params.unset !== true && params.value === void 0) return {
		ok: false,
		error: "plugin session extension value is required unless unset is true"
	};
	const nextPluginValue = params.value;
	const registration = (getActivePluginRegistry()?.sessionExtensions ?? []).find((entry) => entry.pluginId === pluginId && entry.extension.namespace === namespace);
	if (!registration) return {
		ok: false,
		error: `unknown plugin session extension: ${pluginId}/${namespace}`
	};
	const loaded = loadPluginHostHookSessionEntry({
		cfg: params.cfg,
		sessionKey: params.sessionKey
	});
	if (!loaded.entry) return {
		ok: false,
		error: `unknown session key: ${params.sessionKey}`
	};
	const canonicalKey = loaded.canonicalKey ?? params.sessionKey;
	const rawSlotKey = normalizeOptionalString(registration.extension.sessionEntrySlotKey);
	const normalizedSlotKey = rawSlotKey ? normalizeSessionEntrySlotKey(rawSlotKey) : void 0;
	if (normalizedSlotKey?.ok === false) log.warn(`plugin session extension slot promotion skipped for ${pluginId}/${namespace}: ${normalizedSlotKey.error}`);
	const slotKey = normalizedSlotKey?.ok === true ? normalizedSlotKey.key : void 0;
	return {
		ok: true,
		key: canonicalKey,
		value: await updateSessionStore(loaded.storePath, (store) => {
			const entry = store[loaded.storeKey];
			if (!entry) return;
			const entryRecord = entry;
			const pluginExtensions = { ...entry.pluginExtensions };
			const pluginState = { ...pluginExtensions[pluginId] };
			if (params.unset === true) delete pluginState[namespace];
			else pluginState[namespace] = copyJsonValue(nextPluginValue);
			if (Object.keys(pluginState).length > 0) pluginExtensions[pluginId] = pluginState;
			else delete pluginExtensions[pluginId];
			if (Object.keys(pluginExtensions).length > 0) entry.pluginExtensions = pluginExtensions;
			else delete entry.pluginExtensions;
			const storedSlotKeys = { ...entry.pluginExtensionSlotKeys };
			const pluginSlotKeys = { ...storedSlotKeys[pluginId] };
			const previousSlotKey = normalizeSessionEntrySlotKey(pluginSlotKeys[namespace]);
			if (previousSlotKey.ok && previousSlotKey.key !== slotKey) delete entryRecord[previousSlotKey.key];
			if (slotKey && params.unset !== true) pluginSlotKeys[namespace] = slotKey;
			else delete pluginSlotKeys[namespace];
			if (Object.keys(pluginSlotKeys).length > 0) storedSlotKeys[pluginId] = pluginSlotKeys;
			else delete storedSlotKeys[pluginId];
			if (Object.keys(storedSlotKeys).length > 0) entry.pluginExtensionSlotKeys = storedSlotKeys;
			else delete entry.pluginExtensionSlotKeys;
			if (slotKey) {
				const projected = projectSessionExtensionValueForSlot({
					registration,
					sessionKey: canonicalKey,
					sessionId: entry.sessionId,
					nextValue: params.unset === true ? void 0 : nextPluginValue
				});
				if (projected === void 0) delete entryRecord[slotKey];
				else entryRecord[slotKey] = projected;
			}
			entry.updatedAt = Date.now();
			return pluginState[namespace];
		})
	};
}
/**
* Resolve the value that should be mirrored to `SessionEntry[slotKey]` for a
* promoted session-extension namespace. Failures are swallowed so a
* misbehaving projector cannot block the primary patch from being persisted.
*/
function projectSessionExtensionValueForSlot(params) {
	if (params.nextValue === void 0) return;
	const projected = projectSessionExtensionValue({
		pluginId: params.registration.pluginId,
		namespace: params.registration.extension.namespace,
		project: params.registration.extension.project,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId,
		state: params.nextValue
	});
	if (projected === PROJECTION_FAILED) return;
	if (isPromiseLike$1(projected)) {
		discardUnexpectedPromiseProjection(projected);
		return;
	}
	if (projected === void 0 || !isPluginJsonValue(projected)) return;
	return copyJsonValue(projected);
}
function isPromiseLike$1(value) {
	return Boolean(value && typeof value.then === "function");
}
function discardUnexpectedPromiseProjection(value) {
	Promise.resolve(value).catch(() => void 0);
}
function projectSessionExtensionValue(params) {
	try {
		return params.project ? params.project({
			sessionKey: params.sessionKey,
			sessionId: params.sessionId,
			state: params.state
		}) : params.state;
	} catch (error) {
		log.warn(`plugin session extension projection failed: plugin=${params.pluginId} namespace=${params.namespace} error=${String(error)}`);
		return PROJECTION_FAILED;
	}
}
function projectPluginSessionExtensionsSync(params) {
	const extensions = getActivePluginRegistry()?.sessionExtensions ?? [];
	if (extensions.length === 0) return [];
	const projections = [];
	for (const registration of extensions) {
		const state = params.entry.pluginExtensions?.[registration.pluginId]?.[registration.extension.namespace];
		if (state === void 0) continue;
		const projected = projectSessionExtensionValue({
			pluginId: registration.pluginId,
			namespace: registration.extension.namespace,
			project: registration.extension.project,
			sessionKey: params.sessionKey,
			sessionId: params.entry.sessionId,
			state
		});
		if (projected === PROJECTION_FAILED) continue;
		if (isPromiseLike$1(projected)) {
			discardUnexpectedPromiseProjection(projected);
			continue;
		}
		if (projected === void 0 || !isPluginJsonValue(projected)) continue;
		projections.push({
			pluginId: registration.pluginId,
			namespace: registration.extension.namespace,
			value: copyJsonValue(projected)
		});
	}
	return projections;
}
//#endregion
//#region src/media-generation/catalog.ts
function uniqueModels(provider) {
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const candidate of [provider.defaultModel, ...provider.models ?? []]) {
		const model = candidate?.trim();
		if (!model || seen.has(model)) continue;
		seen.add(model);
		models.push(model);
	}
	return models;
}
function synthesizeMediaGenerationCatalogEntries(params) {
	return uniqueModels(params.provider).map((model) => {
		const entry = {
			kind: params.kind,
			provider: params.provider.id,
			model,
			source: "static",
			capabilities: params.provider.capabilities
		};
		if (params.provider.label) entry.label = params.provider.label;
		if (model === params.provider.defaultModel) entry.default = true;
		if (params.modes) entry.modes = params.modes;
		return entry;
	});
}
function listMediaGenerationProviderModels(provider) {
	return uniqueModels(provider);
}
//#endregion
//#region src/plugins/model-catalog-registration.ts
function projectProviderCatalogResultToUnifiedTextRows(params) {
	if (!params.result) return [];
	const providers = "provider" in params.result ? { [params.providerId]: params.result.provider } : params.result.providers;
	const rows = [];
	for (const [providerId, providerConfig] of Object.entries(providers)) for (const model of providerConfig.models ?? []) rows.push({
		kind: "text",
		provider: providerId,
		model: model.id,
		...model.name ? { label: model.name } : {},
		source: params.source
	});
	return rows;
}
function createModelCatalogRegistrationHandlers(params) {
	const registerModelCatalogProvider = (record, provider) => {
		const providerId = normalizeOptionalString(provider.provider) ?? "";
		if (!providerId) {
			params.pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "model catalog provider registration missing provider"
			});
			return;
		}
		if (!provider.kinds || provider.kinds.length === 0) {
			params.pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `model catalog provider "${providerId}" registration missing kinds`
			});
			return;
		}
		const existing = params.registry.modelCatalogProviders.find((entry) => entry.provider.provider === providerId && entry.pluginId !== record.id);
		if (existing) {
			params.pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `model catalog provider already registered: ${providerId} (${existing.pluginId})`
			});
			return;
		}
		const normalizedKinds = [...new Set(provider.kinds)];
		const samePluginOverlapping = params.registry.modelCatalogProviders.find((entry) => entry.provider.provider === providerId && entry.pluginId === record.id && entry.provider.kinds.some((kind) => normalizedKinds.includes(kind)));
		if (samePluginOverlapping) {
			samePluginOverlapping.provider = {
				...samePluginOverlapping.provider,
				...provider,
				provider: providerId,
				kinds: [...new Set([...samePluginOverlapping.provider.kinds, ...normalizedKinds])],
				staticCatalog: provider.staticCatalog ?? samePluginOverlapping.provider.staticCatalog,
				liveCatalog: provider.liveCatalog ?? samePluginOverlapping.provider.liveCatalog
			};
			return;
		}
		params.registry.modelCatalogProviders.push({
			pluginId: record.id,
			pluginName: record.name,
			provider: {
				...provider,
				provider: providerId,
				kinds: normalizedKinds
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerSynthesizedTextModelCatalogProvider = (registration) => {
		if (!registration.provider.catalog && !registration.provider.staticCatalog) return;
		registerModelCatalogProvider(registration.record, {
			provider: registration.provider.id,
			kinds: ["text"],
			...registration.provider.staticCatalog ? { staticCatalog: async (ctx) => projectProviderCatalogResultToUnifiedTextRows({
				providerId: registration.provider.id,
				result: await registration.provider.staticCatalog.run(ctx),
				source: "static"
			}) } : {},
			...registration.provider.catalog ? { liveCatalog: async (ctx) => projectProviderCatalogResultToUnifiedTextRows({
				providerId: registration.provider.id,
				result: await registration.provider.catalog.run(ctx),
				source: "live"
			}) } : {}
		});
	};
	const registerSynthesizedMediaModelCatalogProvider = (registration) => {
		registerModelCatalogProvider(registration.record, {
			provider: registration.provider.id,
			kinds: [registration.kind],
			staticCatalog: () => synthesizeMediaGenerationCatalogEntries({
				kind: registration.kind,
				provider: registration.provider
			})
		});
	};
	return {
		registerModelCatalogProvider,
		registerSynthesizedTextModelCatalogProvider,
		registerSynthesizedMediaModelCatalogProvider
	};
}
//#endregion
//#region src/plugins/provider-validation.ts
const warnedDeprecatedDiscoveryProviders = /* @__PURE__ */ new Set();
function normalizeTextList(values) {
	const normalized = Array.from(new Set(normalizeTrimmedStringList(values)));
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeOnboardingScopes(values) {
	const normalized = Array.from(new Set((values ?? []).filter((value) => value === "text-inference" || value === "image-generation" || value === "music-generation")));
	return normalized.length > 0 ? normalized : void 0;
}
function normalizeProviderOAuthProfileIdRepairs(values) {
	if (!Array.isArray(values)) return;
	const normalized = values.map((value) => {
		const legacyProfileId = normalizeOptionalString(value?.legacyProfileId);
		const promptLabel = normalizeOptionalString(value?.promptLabel);
		if (!legacyProfileId && !promptLabel) return null;
		return {
			...legacyProfileId ? { legacyProfileId } : {},
			...promptLabel ? { promptLabel } : {}
		};
	}).filter((value) => value !== null);
	return normalized.length > 0 ? normalized : void 0;
}
function resolveWizardMethodId(params) {
	if (!params.methodId) return;
	if (params.auth.some((method) => method.id === params.methodId)) return params.methodId;
	pushPluginValidationDiagnostic({
		level: "warn",
		pluginId: params.pluginId,
		source: params.source,
		message: `provider "${params.providerId}" ${params.metadataKind} method "${params.methodId}" not found; falling back to available methods`,
		pushDiagnostic: params.pushDiagnostic
	});
}
function buildNormalizedModelAllowlist(modelAllowlist) {
	if (!modelAllowlist) return;
	const allowedKeys = normalizeTextList(modelAllowlist.allowedKeys);
	const initialSelections = normalizeTextList(modelAllowlist.initialSelections);
	const loadCatalog = modelAllowlist.loadCatalog === true;
	const message = normalizeOptionalString(modelAllowlist.message);
	if (!allowedKeys && !initialSelections && !loadCatalog && !message) return;
	return {
		...allowedKeys ? { allowedKeys } : {},
		...initialSelections ? { initialSelections } : {},
		...loadCatalog ? { loadCatalog } : {},
		...message ? { message } : {}
	};
}
function buildNormalizedWizardSetup(params) {
	const choiceId = normalizeOptionalString(params.setup.choiceId);
	const choiceLabel = normalizeOptionalString(params.setup.choiceLabel);
	const choiceHint = normalizeOptionalString(params.setup.choiceHint);
	const groupId = normalizeOptionalString(params.setup.groupId);
	const groupLabel = normalizeOptionalString(params.setup.groupLabel);
	const groupHint = normalizeOptionalString(params.setup.groupHint);
	const onboardingScopes = normalizeOnboardingScopes(params.setup.onboardingScopes);
	const modelAllowlist = buildNormalizedModelAllowlist(params.setup.modelAllowlist);
	return {
		...choiceId ? { choiceId } : {},
		...choiceLabel ? { choiceLabel } : {},
		...choiceHint ? { choiceHint } : {},
		...typeof params.setup.assistantPriority === "number" && Number.isFinite(params.setup.assistantPriority) ? { assistantPriority: params.setup.assistantPriority } : {},
		...params.setup.assistantVisibility === "manual-only" || params.setup.assistantVisibility === "visible" ? { assistantVisibility: params.setup.assistantVisibility } : {},
		...params.setup.onboardingFeatured === true ? { onboardingFeatured: true } : {},
		...groupId ? { groupId } : {},
		...groupLabel ? { groupLabel } : {},
		...groupHint ? { groupHint } : {},
		...params.methodId ? { methodId: params.methodId } : {},
		...onboardingScopes ? { onboardingScopes } : {},
		...modelAllowlist ? { modelAllowlist } : {}
	};
}
function buildNormalizedModelPicker(modelPicker, methodId) {
	const label = normalizeOptionalString(modelPicker.label);
	const hint = normalizeOptionalString(modelPicker.hint);
	return {
		...label ? { label } : {},
		...hint ? { hint } : {},
		...methodId ? { methodId } : {}
	};
}
function normalizeProviderWizardSetup(params) {
	const hasAuthMethods = params.auth.length > 0;
	if (!params.setup) return;
	if (!hasAuthMethods) {
		pushPluginValidationDiagnostic({
			level: "warn",
			pluginId: params.pluginId,
			source: params.source,
			message: `provider "${params.providerId}" setup metadata ignored because it has no auth methods`,
			pushDiagnostic: params.pushDiagnostic
		});
		return;
	}
	const methodId = resolveWizardMethodId({
		providerId: params.providerId,
		pluginId: params.pluginId,
		source: params.source,
		auth: params.auth,
		methodId: normalizeOptionalString(params.setup.methodId),
		metadataKind: "setup",
		pushDiagnostic: params.pushDiagnostic
	});
	return buildNormalizedWizardSetup({
		setup: params.setup,
		methodId
	});
}
function normalizeProviderAuthMethods(params) {
	const seenMethodIds = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const method of params.auth) {
		const methodId = normalizeOptionalString(method.id);
		if (!methodId) {
			pushPluginValidationDiagnostic({
				level: "error",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${params.providerId}" auth method missing id`,
				pushDiagnostic: params.pushDiagnostic
			});
			continue;
		}
		if (seenMethodIds.has(methodId)) {
			pushPluginValidationDiagnostic({
				level: "error",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${params.providerId}" auth method duplicated id "${methodId}"`,
				pushDiagnostic: params.pushDiagnostic
			});
			continue;
		}
		seenMethodIds.add(methodId);
		const wizardSetup = method.wizard;
		const wizard = wizardSetup ? normalizeProviderWizardSetup({
			providerId: params.providerId,
			pluginId: params.pluginId,
			source: params.source,
			auth: [{
				...method,
				id: methodId
			}],
			setup: wizardSetup,
			pushDiagnostic: params.pushDiagnostic
		}) : void 0;
		normalized.push({
			...method,
			id: methodId,
			label: normalizeOptionalString(method.label) ?? methodId,
			...normalizeOptionalString(method.hint) ? { hint: normalizeOptionalString(method.hint) } : {},
			...wizard ? { wizard } : {}
		});
	}
	return normalized;
}
function normalizeProviderWizard(params) {
	if (!params.wizard) return;
	const hasAuthMethods = params.auth.length > 0;
	const normalizeSetup = () => {
		const setup = params.wizard?.setup;
		if (!setup) return;
		return normalizeProviderWizardSetup({
			providerId: params.providerId,
			pluginId: params.pluginId,
			source: params.source,
			auth: params.auth,
			setup,
			pushDiagnostic: params.pushDiagnostic
		});
	};
	const normalizeModelPicker = () => {
		const modelPicker = params.wizard?.modelPicker;
		if (!modelPicker) return;
		if (!hasAuthMethods) {
			pushPluginValidationDiagnostic({
				level: "warn",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${params.providerId}" model-picker metadata ignored because it has no auth methods`,
				pushDiagnostic: params.pushDiagnostic
			});
			return;
		}
		return buildNormalizedModelPicker(modelPicker, resolveWizardMethodId({
			providerId: params.providerId,
			pluginId: params.pluginId,
			source: params.source,
			auth: params.auth,
			methodId: normalizeOptionalString(modelPicker.methodId),
			metadataKind: "model-picker",
			pushDiagnostic: params.pushDiagnostic
		}));
	};
	const setup = normalizeSetup();
	const modelPicker = normalizeModelPicker();
	if (!setup && !modelPicker) return;
	return {
		...setup ? { setup } : {},
		...modelPicker ? { modelPicker } : {}
	};
}
function normalizeRegisteredProvider(params) {
	const id = normalizeOptionalString(params.provider.id);
	if (!id) {
		pushPluginValidationDiagnostic({
			level: "error",
			pluginId: params.pluginId,
			source: params.source,
			message: "provider registration missing id",
			pushDiagnostic: params.pushDiagnostic
		});
		return null;
	}
	const auth = normalizeProviderAuthMethods({
		providerId: id,
		pluginId: params.pluginId,
		source: params.source,
		auth: params.provider.auth ?? [],
		pushDiagnostic: params.pushDiagnostic
	});
	const docsPath = normalizeOptionalString(params.provider.docsPath);
	const aliases = normalizeTextList(params.provider.aliases);
	const deprecatedProfileIds = normalizeTextList(params.provider.deprecatedProfileIds);
	const oauthProfileIdRepairs = normalizeProviderOAuthProfileIdRepairs(params.provider.oauthProfileIdRepairs);
	const envVars = normalizeTextList(params.provider.envVars);
	const wizard = normalizeProviderWizard({
		providerId: id,
		pluginId: params.pluginId,
		source: params.source,
		auth,
		wizard: params.provider.wizard,
		pushDiagnostic: params.pushDiagnostic
	});
	const catalog = params.provider.catalog;
	const discovery = params.provider.discovery;
	if (catalog && discovery) pushPluginValidationDiagnostic({
		level: "warn",
		pluginId: params.pluginId,
		source: params.source,
		message: `provider "${id}" registered both catalog and discovery; using catalog`,
		pushDiagnostic: params.pushDiagnostic
	});
	if (!catalog && discovery) {
		const warningKey = `${params.pluginId}:${id}:discovery`;
		if (!warnedDeprecatedDiscoveryProviders.has(warningKey)) {
			warnedDeprecatedDiscoveryProviders.add(warningKey);
			pushPluginValidationDiagnostic({
				level: "warn",
				pluginId: params.pluginId,
				source: params.source,
				message: `provider "${id}" uses deprecated discovery; use catalog`,
				pushDiagnostic: params.pushDiagnostic
			});
		}
	}
	const { wizard: _ignoredWizard, docsPath: _ignoredDocsPath, aliases: _ignoredAliases, envVars: _ignoredEnvVars, catalog: _ignoredCatalog, discovery: _ignoredDiscovery, ...restProvider } = params.provider;
	return {
		...restProvider,
		id,
		label: normalizeOptionalString(params.provider.label) ?? id,
		...docsPath ? { docsPath } : {},
		...aliases ? { aliases } : {},
		...deprecatedProfileIds ? { deprecatedProfileIds } : {},
		...oauthProfileIdRepairs ? { oauthProfileIdRepairs } : {},
		...envVars ? { envVars } : {},
		auth,
		...catalog ? { catalog } : {},
		...!catalog && discovery ? { discovery } : {},
		...wizard ? { wizard } : {}
	};
}
//#endregion
//#region src/plugins/registry.ts
const GATEWAY_METHOD_DISPATCH_CONTRACT = "authenticated-request";
const LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT = getPluginCompatRecord("legacy-deactivate-hook-alias");
function formatLegacyDeactivateHookAliasDiagnostic() {
	const removeAfter = LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT.removeAfter ?? "a future breaking release";
	return `typed hook "deactivate" is deprecated (${LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT.code}); use "gateway_stop". This compatibility alias will be removed after ${removeAfter}.`;
}
function normalizeHookTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function resolveTypedHookTimeoutMs(params) {
	return normalizeHookTimeoutMs(params.policy?.timeouts?.[params.hookName]) ?? normalizeHookTimeoutMs(params.policy?.timeoutMs) ?? normalizeHookTimeoutMs(params.opts?.timeoutMs);
}
const constrainLegacyPromptInjectionHook = (handler) => {
	return (event, ctx) => {
		const result = handler(event, ctx);
		if (result && typeof result === "object" && "then" in result) return Promise.resolve(result).then((resolved) => stripPromptMutationFieldsFromLegacyHookResult(resolved));
		return stripPromptMutationFieldsFromLegacyHookResult(result);
	};
};
function resolvePluginPath(input, rootDir) {
	const trimmed = input.trim();
	if (!trimmed || path.isAbsolute(trimmed) || trimmed.startsWith("~")) return resolveUserPath(input);
	return rootDir ? path.resolve(rootDir, trimmed) : resolveUserPath(input);
}
function isOfficialCodexPluginRecord(record) {
	if (record.id !== "codex") return false;
	if (record.origin !== "global") return false;
	if (record.packageName === "@openclaw/codex") return true;
	return path.normalize(record.rootDir ?? record.source).split(path.sep).join("/").includes("/node_modules/@openclaw/codex");
}
function canClaimReservedCommandOwnership(record) {
	return record.origin === "bundled" || isOfficialCodexPluginRecord(record);
}
const activePluginHookRegistrations = resolveGlobalSingleton(Symbol.for("openclaw.activePluginHookRegistrations"), () => /* @__PURE__ */ new Map());
/**
* Keep mode decoding centralized. PluginRegistrationMode is the public label;
* registry code should consume these booleans instead of duplicating string
* checks across individual registration handlers.
*/
function resolvePluginRegistrationCapabilities(mode) {
	return {
		capabilityHandlers: mode === "full" || mode === "discovery" || mode === "tool-discovery",
		runtimeChannel: mode !== "setup-only" && mode !== "tool-discovery"
	};
}
function createPluginRegistry(registryParams) {
	const registry = createEmptyPluginRegistry();
	const coreGatewayMethodNames = Array.from(new Set([...registryParams.coreGatewayMethodNames ?? [], ...Object.keys(registryParams.coreGatewayHandlers ?? {})])).toSorted();
	registry.coreGatewayMethodNames = coreGatewayMethodNames;
	const coreGatewayMethods = new Set(coreGatewayMethodNames);
	const getHostCronService = () => registryParams.hostServices?.cron;
	const pluginHookRollback = /* @__PURE__ */ new Map();
	const pluginsWithChannelRegistrationConflict = /* @__PURE__ */ new Set();
	const pluginSideEffectGuards = /* @__PURE__ */ new Map();
	const pushDiagnostic = (diag) => {
		registry.diagnostics.push(diag);
	};
	const { registerModelCatalogProvider, registerSynthesizedTextModelCatalogProvider, registerSynthesizedMediaModelCatalogProvider } = createModelCatalogRegistrationHandlers({
		registry,
		pushDiagnostic
	});
	const throwRegistrationError = (message) => {
		throw new Error(message);
	};
	const requireRegistrationValue = (value, message) => {
		if (!value) throw new Error(message);
		return value;
	};
	const createPluginSideEffectGuard = (pluginId) => {
		const guard = { active: true };
		const guards = pluginSideEffectGuards.get(pluginId) ?? /* @__PURE__ */ new Set();
		guards.add(guard);
		pluginSideEffectGuards.set(pluginId, guards);
		return guard;
	};
	const deactivatePluginSideEffectGuards = (pluginId) => {
		const guards = pluginSideEffectGuards.get(pluginId);
		if (!guards) return;
		for (const guard of guards) guard.active = false;
		pluginSideEffectGuards.delete(pluginId);
	};
	const registerCodexAppServerExtensionFactory = (record, factory) => {
		if (record.origin !== "bundled") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "only bundled plugins can register Codex app-server extension factories"
			});
			return;
		}
		if (!(record.contracts?.embeddedExtensionFactories ?? []).includes("codex-app-server")) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "plugin must declare contracts.embeddedExtensionFactories: [\"codex-app-server\"] to register Codex app-server extension factories"
			});
			return;
		}
		if (typeof factory !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "codex app-server extension factory must be a function"
			});
			return;
		}
		if (registry.codexAppServerExtensionFactories.some((entry) => entry.pluginId === record.id && entry.rawFactory === factory)) return;
		const safeFactory = async (codex) => {
			try {
				await factory(codex);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				registryParams.logger.warn(`[plugins] codex app-server extension factory failed for ${record.id}: ${detail}`);
			}
		};
		registry.codexAppServerExtensionFactories.push({
			pluginId: record.id,
			pluginName: record.name,
			rawFactory: factory,
			factory: safeFactory,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerAgentToolResultMiddleware = (record, handler, options) => {
		if (record.origin !== "bundled") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "only bundled plugins can register agent tool result middleware"
			});
			return;
		}
		if (typeof handler !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "agent tool result middleware must be a function"
			});
			return;
		}
		const runtimes = normalizeAgentToolResultMiddlewareRuntimes(options);
		if (runtimes.length === 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "agent tool result middleware must target at least one supported runtime"
			});
			return;
		}
		const declared = normalizeAgentToolResultMiddlewareRuntimeIds(record.contracts?.agentToolResultMiddleware);
		const missing = runtimes.filter((runtime) => !declared.includes(runtime));
		if (missing.length > 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `plugin must declare contracts.agentToolResultMiddleware for: ${missing.join(", ")}`
			});
			return;
		}
		const existing = registry.agentToolResultMiddlewares.find((entry) => entry.pluginId === record.id && entry.rawHandler === handler);
		if (existing) {
			existing.runtimes = [...new Set([...existing.runtimes, ...runtimes])];
			return;
		}
		const safeHandler = async (event, ctx) => {
			try {
				return await handler(event, ctx);
			} catch (error) {
				registryParams.logger.warn(`[plugins] agent tool result middleware failed for ${record.id}`);
				throw error;
			}
		};
		registry.agentToolResultMiddlewares.push({
			pluginId: record.id,
			pluginName: record.name,
			rawHandler: handler,
			handler: safeHandler,
			runtimes,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerTool = (record, tool, opts) => {
		if (pluginsWithChannelRegistrationConflict.has(record.id)) return;
		const declaredNames = normalizePluginToolContractNames(record.contracts);
		if (declaredNames.length === 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "plugin must declare contracts.tools before registering agent tools"
			});
			return;
		}
		const names = [...opts?.names ?? [], ...opts?.name ? [opts.name] : []];
		const optional = opts?.optional === true;
		const factory = typeof tool === "function" ? tool : (_ctx) => tool;
		if (typeof tool !== "function") names.push(tool.name);
		const normalized = normalizePluginToolNames(names);
		const undeclared = findUndeclaredPluginToolNames({
			declaredNames,
			toolNames: normalized
		});
		if (undeclared.length > 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`
			});
			return;
		}
		if (normalized.length > 0) record.toolNames.push(...normalized);
		registry.tools.push({
			pluginId: record.id,
			pluginName: record.name,
			factory,
			names: normalized,
			declaredNames,
			optional,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerHook = (record, events, handler, opts, config, pluginConfig) => {
		const normalizedEvents = (Array.isArray(events) ? events : [events]).map((event) => event.trim()).filter(Boolean);
		const entry = opts?.entry ?? null;
		const hookName = requireRegistrationValue(entry?.hook.name ?? opts?.name?.trim(), "hook registration missing name");
		const existingHook = registry.hooks.find((entry) => entry.entry.hook.name === hookName);
		if (existingHook) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `hook already registered: ${hookName} (${existingHook.pluginId})`
			});
			return;
		}
		const description = entry?.hook.description ?? opts?.description ?? "";
		const hookEntry = entry ? {
			...entry,
			hook: {
				...entry.hook,
				name: hookName,
				description,
				source: "openclaw-plugin",
				pluginId: record.id
			},
			metadata: {
				...entry.metadata,
				events: normalizedEvents
			}
		} : {
			hook: {
				name: hookName,
				description,
				source: "openclaw-plugin",
				pluginId: record.id,
				filePath: record.source,
				baseDir: path.dirname(record.source),
				handlerPath: record.source
			},
			frontmatter: {},
			metadata: { events: normalizedEvents },
			invocation: { enabled: true }
		};
		record.hookNames.push(hookName);
		registry.hooks.push({
			pluginId: record.id,
			entry: hookEntry,
			events: normalizedEvents,
			source: record.source
		});
		const hookSystemEnabled = config?.hooks?.internal?.enabled !== false;
		if (!registryParams.activateGlobalSideEffects || !hookSystemEnabled || opts?.register === false) return;
		const previousRegistrations = activePluginHookRegistrations.get(hookName) ?? [];
		for (const registration of previousRegistrations) unregisterInternalHook(registration.event, registration.handler);
		const nextRegistrations = [];
		for (const event of normalizedEvents) {
			const wrappedHandler = async (evt) => {
				return handler({
					...evt,
					context: {
						...evt.context,
						pluginConfig
					}
				});
			};
			registerInternalHook(event, wrappedHandler);
			nextRegistrations.push({
				event,
				handler: wrappedHandler
			});
		}
		activePluginHookRegistrations.set(hookName, nextRegistrations);
		const rollbackEntries = pluginHookRollback.get(record.id) ?? [];
		rollbackEntries.push({
			name: hookName,
			previousRegistrations: [...previousRegistrations]
		});
		pluginHookRollback.set(record.id, rollbackEntries);
	};
	const registerGatewayMethod = (record, method, handler, opts) => {
		const trimmed = method.trim();
		if (!trimmed) return;
		if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `gateway method already registered: ${trimmed}`
			});
			return;
		}
		registry.gatewayHandlers[trimmed] = handler;
		const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
		if (normalizedScope.coercedToReservedAdmin) pushDiagnostic({
			level: "warn",
			pluginId: record.id,
			source: record.source,
			message: `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`
		});
		registry.gatewayMethodDescriptors.push(createPluginGatewayMethodDescriptor({
			pluginId: record.id,
			name: trimmed,
			handler,
			scope: normalizedScope.scope
		}));
	};
	const describeHttpRouteOwner = (entry) => {
		return `${normalizeOptionalString(entry.pluginId) || "unknown-plugin"} (${normalizeOptionalString(entry.source) || "unknown-source"})`;
	};
	const canDispatchGatewayMethodsFromHttpRoute = (record) => (record.contracts?.gatewayMethodDispatch ?? []).includes(GATEWAY_METHOD_DISPATCH_CONTRACT);
	const registerHttpRoute = (record, params) => {
		const normalizedPath = normalizePluginHttpPath(params.path);
		if (!normalizedPath) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "http route registration missing path"
			});
			return;
		}
		if (params.auth !== "gateway" && params.auth !== "plugin") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `http route registration missing or invalid auth: ${normalizedPath}`
			});
			return;
		}
		const match = params.match ?? "exact";
		const overlappingRoute = findOverlappingPluginHttpRoute(registry.httpRoutes, {
			path: normalizedPath,
			match
		});
		if (overlappingRoute && overlappingRoute.auth !== params.auth) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) owned by ${describeHttpRouteOwner(overlappingRoute)}`
			});
			return;
		}
		const existingIndex = registry.httpRoutes.findIndex((entry) => entry.path === normalizedPath && entry.match === match);
		if (existingIndex >= 0) {
			const existing = registry.httpRoutes[existingIndex];
			if (!existing) return;
			if (!params.replaceExisting && existing.pluginId !== record.id) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`
				});
				return;
			}
			if (existing.pluginId && existing.pluginId !== record.id) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`
				});
				return;
			}
			registry.httpRoutes[existingIndex] = {
				pluginId: record.id,
				path: normalizedPath,
				handler: params.handler,
				...params.handleUpgrade ? { handleUpgrade: params.handleUpgrade } : {},
				auth: params.auth,
				match,
				...params.gatewayRuntimeScopeSurface ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface } : {},
				...canDispatchGatewayMethodsFromHttpRoute(record) ? { gatewayMethodDispatchAllowed: true } : {},
				...params.nodeCapability ? { nodeCapability: { ...params.nodeCapability } } : {},
				source: record.source
			};
			return;
		}
		record.httpRoutes += 1;
		registry.httpRoutes.push({
			pluginId: record.id,
			path: normalizedPath,
			handler: params.handler,
			...params.handleUpgrade ? { handleUpgrade: params.handleUpgrade } : {},
			auth: params.auth,
			match,
			...params.gatewayRuntimeScopeSurface ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface } : {},
			...canDispatchGatewayMethodsFromHttpRoute(record) ? { gatewayMethodDispatchAllowed: true } : {},
			...params.nodeCapability ? { nodeCapability: { ...params.nodeCapability } } : {},
			source: record.source
		});
	};
	const registerHostedMediaResolver = (record, resolver) => {
		if (typeof resolver !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "hosted media resolver registration missing resolver"
			});
			return;
		}
		(registry.hostedMediaResolvers ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			resolver,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerChannel = (record, registration, mode = "full") => {
		const registrationCapabilities = resolvePluginRegistrationCapabilities(mode);
		const normalized = typeof registration.plugin === "object" ? registration : { plugin: registration };
		const plugin = normalizeRegisteredChannelPlugin({
			pluginId: record.id,
			source: record.source,
			plugin: normalized.plugin,
			pushDiagnostic
		});
		if (!plugin) return;
		const id = plugin.id;
		const existingRuntime = registry.channels.find((entry) => entry.plugin.id === id);
		if (registrationCapabilities.runtimeChannel && existingRuntime) {
			if (existingRuntime.pluginId === record.id) {
				existingRuntime.plugin = plugin;
				existingRuntime.pluginName = record.name;
				existingRuntime.source = record.source;
				existingRuntime.rootDir = record.rootDir;
				const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
				if (existingSetup) {
					existingSetup.plugin = plugin;
					existingSetup.pluginName = record.name;
					existingSetup.source = record.source;
					existingSetup.enabled = record.enabled;
					existingSetup.rootDir = record.rootDir;
				}
				return;
			}
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `channel already registered: ${id} (${existingRuntime.pluginId})`
			});
			pluginsWithChannelRegistrationConflict.add(record.id);
			return;
		}
		const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
		if (existingSetup) {
			if (existingSetup.pluginId === record.id) {
				existingSetup.plugin = plugin;
				existingSetup.pluginName = record.name;
				existingSetup.source = record.source;
				existingSetup.enabled = record.enabled;
				existingSetup.rootDir = record.rootDir;
				return;
			}
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `channel setup already registered: ${id} (${existingSetup.pluginId})`
			});
			pluginsWithChannelRegistrationConflict.add(record.id);
			return;
		}
		if (!record.channelIds.includes(id)) record.channelIds.push(id);
		registry.channelSetups.push({
			pluginId: record.id,
			pluginName: record.name,
			plugin,
			source: record.source,
			enabled: record.enabled,
			rootDir: record.rootDir
		});
		if (!registrationCapabilities.runtimeChannel) return;
		registry.channels.push({
			pluginId: record.id,
			pluginName: record.name,
			plugin,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerProvider = (record, provider) => {
		const normalizedProvider = normalizeRegisteredProvider({
			pluginId: record.id,
			source: record.source,
			provider,
			pushDiagnostic
		});
		if (!normalizedProvider) return;
		const id = normalizedProvider.id;
		const existing = registry.providers.find((entry) => entry.provider.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `provider already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		if (!record.providerIds.includes(id)) record.providerIds.push(id);
		registry.providers.push({
			pluginId: record.id,
			pluginName: record.name,
			provider: normalizedProvider,
			source: record.source,
			rootDir: record.rootDir
		});
		registerSynthesizedTextModelCatalogProvider({
			record,
			provider: normalizedProvider
		});
	};
	const registerAgentHarness$1 = (record, harness) => {
		const id = normalizeOptionalString(harness?.id) ?? "";
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "agent harness registration missing id"
			});
			return;
		}
		if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `agent harness "${id}" registration missing required runtime methods`
			});
			return;
		}
		const existing = registryParams.activateGlobalSideEffects === false ? registry.agentHarnesses.find((entry) => entry.harness.id === id) : getRegisteredAgentHarness(id);
		if (existing) {
			const ownerPluginId = "ownerPluginId" in existing ? existing.ownerPluginId : "pluginId" in existing ? existing.pluginId : void 0;
			const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `agent harness already registered: ${id}${ownerDetail}`
			});
			return;
		}
		const normalizedHarness = {
			...harness,
			id,
			pluginId: harness.pluginId ?? record.id
		};
		if (registryParams.activateGlobalSideEffects !== false) registerAgentHarness(normalizedHarness, { ownerPluginId: record.id });
		record.agentHarnessIds.push(id);
		registry.agentHarnesses.push({
			pluginId: record.id,
			pluginName: record.name,
			harness: normalizedHarness,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerCliBackend = (record, backend) => {
		const id = backend.id.trim();
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "cli backend registration missing id"
			});
			return;
		}
		const existing = (registry.cliBackends ?? []).find((entry) => entry.backend.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `cli backend already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		(registry.cliBackends ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			backend: {
				...backend,
				id
			},
			source: record.source,
			rootDir: record.rootDir
		});
		record.cliBackendIds.push(id);
	};
	const registerTextTransforms = (record, transforms) => {
		if ((!transforms.input || transforms.input.length === 0) && (!transforms.output || transforms.output.length === 0)) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "text transform registration has no input or output replacements"
			});
			return;
		}
		registry.textTransforms.push({
			pluginId: record.id,
			pluginName: record.name,
			transforms,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerEmbeddingProviderForPlugin = (record, adapter) => {
		const id = adapter.id.trim();
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "embedding provider registration missing id"
			});
			return;
		}
		if (!(record.contracts?.embeddingProviders ?? []).includes(id)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `plugin must declare contracts.embeddingProviders for adapter: ${id}`
			});
			return;
		}
		const existing = registryParams.activateGlobalSideEffects === false ? registry.embeddingProviders.find((entry) => entry.provider.id === id) : getRegisteredEmbeddingProvider(id);
		if (existing) {
			const ownerPluginId = "ownerPluginId" in existing ? existing.ownerPluginId : "pluginId" in existing ? existing.pluginId : void 0;
			const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `embedding provider already registered: ${id}${ownerDetail}`
			});
			return;
		}
		if (registryParams.activateGlobalSideEffects !== false) registerEmbeddingProvider(adapter, { ownerPluginId: record.id });
		registry.embeddingProviders.push({
			pluginId: record.id,
			pluginName: record.name,
			provider: adapter,
			source: record.source,
			rootDir: record.rootDir
		});
		if (!record.embeddingProviderIds.includes(id)) record.embeddingProviderIds.push(id);
	};
	const registerUniqueProviderLike = (params) => {
		const id = params.provider.id.trim();
		const { record, kindLabel } = params;
		const missingLabel = `${kindLabel} registration missing id`;
		const duplicateLabel = `${kindLabel} already registered: ${id}`;
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: missingLabel
			});
			return false;
		}
		const existing = params.registrations.find((entry) => entry.provider.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `${duplicateLabel} (${existing.pluginId})`
			});
			return false;
		}
		if (!params.ownedIds.includes(id)) params.ownedIds.push(id);
		params.registrations.push({
			pluginId: record.id,
			pluginName: record.name,
			provider: params.provider,
			source: record.source,
			rootDir: record.rootDir
		});
		return true;
	};
	const registerSpeechProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "speech provider",
			registrations: registry.speechProviders,
			ownedIds: record.speechProviderIds
		});
	};
	const registerRealtimeTranscriptionProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "realtime transcription provider",
			registrations: registry.realtimeTranscriptionProviders,
			ownedIds: record.realtimeTranscriptionProviderIds
		});
	};
	const registerRealtimeVoiceProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "realtime voice provider",
			registrations: registry.realtimeVoiceProviders,
			ownedIds: record.realtimeVoiceProviderIds
		});
	};
	const registerMediaUnderstandingProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "media provider",
			registrations: registry.mediaUnderstandingProviders,
			ownedIds: record.mediaUnderstandingProviderIds
		});
	};
	const registerImageGenerationProvider = (record, provider) => {
		if (registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "image-generation provider",
			registrations: registry.imageGenerationProviders,
			ownedIds: record.imageGenerationProviderIds
		})) registerSynthesizedMediaModelCatalogProvider({
			record,
			kind: "image_generation",
			provider
		});
	};
	const registerVideoGenerationProvider = (record, provider) => {
		if (registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "video-generation provider",
			registrations: registry.videoGenerationProviders,
			ownedIds: record.videoGenerationProviderIds
		})) registerSynthesizedMediaModelCatalogProvider({
			record,
			kind: "video_generation",
			provider
		});
	};
	const registerMusicGenerationProvider = (record, provider) => {
		if (registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "music-generation provider",
			registrations: registry.musicGenerationProviders,
			ownedIds: record.musicGenerationProviderIds
		})) registerSynthesizedMediaModelCatalogProvider({
			record,
			kind: "music_generation",
			provider
		});
	};
	const registerWebFetchProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "web fetch provider",
			registrations: registry.webFetchProviders,
			ownedIds: record.webFetchProviderIds
		});
	};
	const registerWebSearchProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "web search provider",
			registrations: registry.webSearchProviders,
			ownedIds: record.webSearchProviderIds
		});
	};
	const registerMigrationProvider = (record, provider) => {
		registerUniqueProviderLike({
			record,
			provider,
			kindLabel: "migration provider",
			registrations: registry.migrationProviders,
			ownedIds: record.migrationProviderIds
		});
	};
	const registerCli = (record, registrar, opts) => {
		const normalizeCommandRoot = (raw, source) => {
			const normalized = normalizeCommandDescriptorName(raw);
			if (!normalized) pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `invalid cli ${source} name: ${JSON.stringify(raw.trim())}`
			});
			return normalized;
		};
		const parentPath = (opts?.parentPath ?? []).map((segment) => normalizeCommandRoot(segment, "command"));
		if (parentPath.some((segment) => segment === null)) return;
		const normalizedParentPath = parentPath;
		const descriptors = (opts?.descriptors ?? []).map((descriptor) => {
			const name = normalizeCommandRoot(descriptor.name, "descriptor");
			const description = sanitizeCommandDescriptorDescription(descriptor.description);
			return name && description ? {
				name,
				description,
				hasSubcommands: descriptor.hasSubcommands
			} : null;
		}).filter((descriptor) => descriptor !== null);
		const commands = [...opts?.commands ?? [], ...descriptors.map((descriptor) => descriptor.name)].map((cmd) => normalizeCommandRoot(cmd, "command")).filter((command) => command !== null);
		if (commands.length === 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "cli registration missing explicit commands metadata"
			});
			return;
		}
		const serializeCommandPath = (command) => [...normalizedParentPath, command].join(" ");
		const commandPaths = commands.map(serializeCommandPath);
		const commandPathSet = new Set(commandPaths);
		const existing = registry.cliRegistrars.find((entry) => entry.commands.map((command) => [...entry.parentPath ?? [], command].join(" ")).some((commandPath) => commandPathSet.has(commandPath)));
		if (existing) {
			const existingCommandPaths = new Set(existing.commands.map((command) => [...existing.parentPath ?? [], command].join(" ")));
			const overlap = commandPaths.find((commandPath) => existingCommandPaths.has(commandPath));
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`
			});
			return;
		}
		record.cliCommands.push(...commandPaths);
		registry.cliRegistrars.push({
			pluginId: record.id,
			pluginName: record.name,
			register: registrar,
			parentPath: normalizedParentPath,
			commands,
			descriptors,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const reservedNodeHostCommands = new Set([
		...NODE_SYSTEM_RUN_COMMANDS,
		...NODE_EXEC_APPROVALS_COMMANDS,
		NODE_SYSTEM_NOTIFY_COMMAND
	]);
	const registerReload = (record, registration) => {
		const normalize = (values) => (values ?? []).map((value) => value.trim()).filter(Boolean);
		const normalized = {
			restartPrefixes: normalize(registration.restartPrefixes),
			hotPrefixes: normalize(registration.hotPrefixes),
			noopPrefixes: normalize(registration.noopPrefixes)
		};
		if ((normalized.restartPrefixes?.length ?? 0) === 0 && (normalized.hotPrefixes?.length ?? 0) === 0 && (normalized.noopPrefixes?.length ?? 0) === 0) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: "reload registration missing prefixes"
			});
			return;
		}
		registry.reloads ??= [];
		registry.reloads.push({
			pluginId: record.id,
			pluginName: record.name,
			registration: normalized,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerNodeHostCommand = (record, nodeCommand) => {
		const command = nodeCommand.command.trim();
		if (!command) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "node host command registration missing command"
			});
			return;
		}
		if (reservedNodeHostCommands.has(command)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `node host command reserved by core: ${command}`
			});
			return;
		}
		registry.nodeHostCommands ??= [];
		const existing = registry.nodeHostCommands.find((entry) => entry.command.command === command);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `node host command already registered: ${command} (${existing.pluginId})`
			});
			return;
		}
		registry.nodeHostCommands.push({
			pluginId: record.id,
			pluginName: record.name,
			command: {
				...nodeCommand,
				command,
				cap: normalizeOptionalString(nodeCommand.cap)
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerNodeInvokePolicy = (record, policy, pluginConfig) => {
		const commands = Array.isArray(policy.commands) ? policy.commands.map((command) => command.trim()).filter(Boolean) : [];
		if (commands.length === 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "node invoke policy registration missing commands"
			});
			return;
		}
		if (typeof policy.handle !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `node invoke policy registration missing handler: ${commands.join(", ")}`
			});
			return;
		}
		registry.nodeInvokePolicies ??= [];
		for (const command of commands) {
			const existing = registry.nodeInvokePolicies.find((entry) => entry.policy.commands.includes(command));
			if (existing) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `node invoke policy already registered for ${command} (${existing.pluginId})`
				});
				return;
			}
		}
		registry.nodeInvokePolicies.push({
			pluginId: record.id,
			pluginName: record.name,
			policy: {
				...policy,
				commands
			},
			pluginConfig,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerSecurityAuditCollector = (record, collector) => {
		registry.securityAuditCollectors ??= [];
		registry.securityAuditCollectors.push({
			pluginId: record.id,
			pluginName: record.name,
			collector,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerService = (record, service) => {
		const id = service.id.trim();
		if (!id) return;
		const existing = registry.services.find((entry) => entry.service.id === id);
		if (existing) {
			if (existing.pluginId === record.id) return;
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `service already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		record.services.push(id);
		registry.services.push({
			pluginId: record.id,
			pluginName: record.name,
			service,
			source: record.source,
			origin: record.origin,
			trustedOfficialInstall: record.trustedOfficialInstall,
			rootDir: record.rootDir
		});
	};
	const registerGatewayDiscoveryService = (record, service) => {
		const id = service.id.trim();
		if (!id) return;
		const existing = registry.gatewayDiscoveryServices.find((entry) => entry.service.id === id);
		if (existing) {
			if (existing.pluginId === record.id) return;
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `gateway discovery service already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		record.gatewayDiscoveryServiceIds.push(id);
		registry.gatewayDiscoveryServices.push({
			pluginId: record.id,
			pluginName: record.name,
			service,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerCommand = (record, command) => {
		const name = command.name.trim();
		if (!name) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "command registration missing name"
			});
			return;
		}
		const allowReservedCommandNames = command.ownership === "reserved";
		if (allowReservedCommandNames && !canClaimReservedCommandOwnership(record)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `only bundled plugins can claim reserved command ownership: ${name}`
			});
			return;
		}
		if (allowReservedCommandNames && !isReservedCommandName(name)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `reserved command ownership requires a reserved command name: ${name}`
			});
			return;
		}
		if (allowReservedCommandNames && record.id !== normalizeLowercaseStringOrEmpty(name)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `command registration failed: Reserved command ownership requires plugin id "${record.id}" to match reserved command name "${normalizeLowercaseStringOrEmpty(name)}"`
			});
			return;
		}
		if (!registryParams.activateGlobalSideEffects) {
			const validationError = validatePluginCommandDefinition(command, { allowReservedCommandNames });
			if (validationError) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `command registration failed: ${validationError}`
				});
				return;
			}
		} else {
			const { ownership: _ownership, ...commandForRegistration } = command;
			const result = registerPluginCommand(record.id, allowReservedCommandNames ? commandForRegistration : command, {
				pluginName: record.name,
				pluginRoot: record.rootDir,
				allowReservedCommandNames
			});
			if (!result.ok) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `command registration failed: ${result.error}`
				});
				return;
			}
			if (allowReservedCommandNames) {
				const registeredCommand = pluginCommands.get(`/${name.toLowerCase()}`);
				if (registeredCommand?.pluginId === record.id) registeredCommand.ownership = "reserved";
			}
		}
		record.commands.push(name);
		registry.commands.push({
			pluginId: record.id,
			pluginName: record.name,
			command,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const normalizeHostHookString = (value) => typeof value === "string" ? normalizePluginHostHookId(value) : "";
	const normalizeOptionalHostHookString = (value) => {
		if (value === void 0) return;
		if (typeof value !== "string") return "";
		return value.trim();
	};
	const normalizeHostHookStringList = (value) => {
		if (value === void 0) return;
		if (!Array.isArray(value)) return null;
		const normalized = value.map((item) => normalizeOptionalHostHookString(item));
		if (normalized.some((item) => !item)) return null;
		return normalized;
	};
	const validateSessionActionSchema = (record, id, schema) => {
		if (schema === void 0) return true;
		if (!isPluginJsonValue(schema)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session action schema must be JSON-compatible: ${id}`
			});
			return false;
		}
		if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session action schema must be a JSON schema object or boolean: ${id}`
			});
			return false;
		}
		try {
			validateJsonSchemaValue({
				schema,
				cacheKey: `plugin-session-action-registration:${record.id}:${id}`,
				value: void 0
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session action schema is not valid JSON Schema: ${id}: ${message}`
			});
			return false;
		}
		return true;
	};
	const controlUiSurfaces = new Set([
		"session",
		"tool",
		"run",
		"settings"
	]);
	const registerSessionExtension = (record, extension) => {
		const namespace = normalizeHostHookString(extension.namespace);
		const description = normalizeHostHookString(extension.description);
		const project = extension.project;
		let normalizedSessionEntrySlotKey;
		let invalidMessage;
		if (!namespace || !description) invalidMessage = "session extension registration requires namespace and description";
		else if (project !== void 0 && typeof project !== "function") invalidMessage = "session extension projector must be a function";
		else if (project?.constructor?.name === "AsyncFunction") invalidMessage = "session extension projector must be synchronous";
		else if (extension.cleanup !== void 0 && typeof extension.cleanup !== "function") invalidMessage = "session extension cleanup must be a function";
		else if (extension.sessionEntrySlotKey !== void 0) {
			const slotKey = normalizeSessionEntrySlotKey(extension.sessionEntrySlotKey);
			if (!slotKey.ok) invalidMessage = slotKey.error;
			else normalizedSessionEntrySlotKey = slotKey.key;
		}
		if (invalidMessage) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: invalidMessage
			});
			return;
		}
		if ((registry.sessionExtensions ?? []).find((entry) => entry.pluginId === record.id && entry.extension.namespace === namespace)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session extension already registered: ${namespace}`
			});
			return;
		}
		if (normalizedSessionEntrySlotKey) {
			if ((registry.sessionExtensions ?? []).find((entry) => {
				const existingSlotKey = entry.extension.sessionEntrySlotKey;
				if (existingSlotKey === void 0) return false;
				const normalizedExistingSlotKey = normalizeSessionEntrySlotKey(existingSlotKey);
				return normalizedExistingSlotKey.ok && normalizedExistingSlotKey.key === normalizedSessionEntrySlotKey;
			})) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `sessionEntrySlotKey already registered: ${normalizedSessionEntrySlotKey}`
				});
				return;
			}
		}
		(registry.sessionExtensions ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			extension: {
				...extension,
				namespace,
				description,
				...normalizedSessionEntrySlotKey ? { sessionEntrySlotKey: normalizedSessionEntrySlotKey } : {}
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerTrustedToolPolicy = (record, policy) => {
		if (record.origin !== "bundled") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "only bundled plugins can register trusted tool policies"
			});
			return;
		}
		const id = normalizeHostHookString(policy.id);
		const description = normalizeHostHookString(policy.description);
		if (!id || !description || typeof policy.evaluate !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "trusted tool policy registration requires id, description, and evaluate()"
			});
			return;
		}
		const existing = (registry.trustedToolPolicies ?? []).find((entry) => entry.policy.id === id);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `trusted tool policy already registered: ${id} (${existing.pluginId})`
			});
			return;
		}
		(registry.trustedToolPolicies ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			policy: {
				...policy,
				id,
				description
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerToolMetadata = (record, metadata) => {
		const toolName = normalizeHostHookString(metadata.toolName);
		if (!toolName) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "tool metadata registration missing toolName"
			});
			return;
		}
		const undeclared = findUndeclaredPluginToolNames({
			declaredNames: normalizePluginToolContractNames(record.contracts),
			toolNames: [toolName]
		});
		if (undeclared.length > 0) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `plugin must declare contracts.tools for tool metadata: ${undeclared.join(", ")}`
			});
			return;
		}
		const existing = (registry.toolMetadata ?? []).find((entry) => entry.pluginId === record.id && entry.metadata.toolName === toolName);
		if (existing) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `tool metadata already registered: ${toolName} (${existing.pluginId})`
			});
			return;
		}
		const displayName = normalizeOptionalHostHookString(metadata.displayName);
		const description = normalizeOptionalHostHookString(metadata.description);
		const tags = normalizeHostHookStringList(metadata.tags);
		if (displayName === "" || description === "" || tags === null || metadata.risk !== void 0 && ![
			"low",
			"medium",
			"high"
		].includes(metadata.risk)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `tool metadata registration has invalid metadata: ${toolName}`
			});
			return;
		}
		(registry.toolMetadata ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			metadata: {
				...metadata,
				toolName,
				...displayName !== void 0 ? { displayName } : {},
				...description !== void 0 ? { description } : {},
				...tags !== void 0 ? { tags } : {}
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerControlUiDescriptor = (record, descriptor) => {
		const id = normalizeHostHookString(descriptor.id);
		const label = normalizeHostHookString(descriptor.label);
		const description = normalizeOptionalHostHookString(descriptor.description);
		const placement = normalizeOptionalHostHookString(descriptor.placement);
		const requiredScopes = normalizeHostHookStringList(descriptor.requiredScopes);
		const surface = typeof descriptor.surface === "string" ? descriptor.surface : "";
		if (!id || !label || !controlUiSurfaces.has(surface) || description === "" || placement === "" || requiredScopes === null) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "control UI descriptor registration requires id, surface, label, and valid optional fields"
			});
			return;
		}
		if (requiredScopes !== void 0) {
			const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
			if (unknownScope !== void 0) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `control UI descriptor requiredScopes contains unknown operator scope: ${unknownScope}`
				});
				return;
			}
		}
		if (descriptor.schema !== void 0 && !isPluginJsonValue(descriptor.schema)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `control UI descriptor schema must be JSON-compatible: ${id}`
			});
			return;
		}
		if ((registry.controlUiDescriptors ?? []).find((entry) => entry.pluginId === record.id && entry.descriptor.id === id)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `control UI descriptor already registered: ${id}`
			});
			return;
		}
		(registry.controlUiDescriptors ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			descriptor: {
				...descriptor,
				id,
				surface,
				label,
				...description !== void 0 ? { description } : {},
				...placement !== void 0 ? { placement } : {},
				...requiredScopes !== void 0 ? { requiredScopes } : {}
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerRuntimeLifecycle = (record, lifecycle) => {
		const id = normalizePluginHostHookId(lifecycle.id);
		if (!id) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "runtime lifecycle registration missing id"
			});
			return;
		}
		if ((registry.runtimeLifecycles ?? []).find((entry) => entry.pluginId === record.id && entry.lifecycle.id === id)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `runtime lifecycle already registered: ${id}`
			});
			return;
		}
		if (lifecycle.cleanup !== void 0 && typeof lifecycle.cleanup !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `runtime lifecycle cleanup must be a function: ${id}`
			});
			return;
		}
		(registry.runtimeLifecycles ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			lifecycle: {
				...lifecycle,
				id
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerAgentEventSubscription = (record, subscription) => {
		const id = normalizePluginHostHookId(subscription.id);
		if (!id || typeof subscription.handle !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "agent event subscription registration requires id and handle"
			});
			return;
		}
		const streams = normalizeHostHookStringList(subscription.streams);
		if (streams === null) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `agent event subscription streams must be an array of strings: ${id}`
			});
			return;
		}
		if ((registry.agentEventSubscriptions ?? []).find((entry) => entry.pluginId === record.id && entry.subscription.id === id)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `agent event subscription already registered: ${id}`
			});
			return;
		}
		(registry.agentEventSubscriptions ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			subscription: {
				...subscription,
				id,
				...streams !== void 0 ? { streams } : {}
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerSessionSchedulerJob = (record, job) => {
		const jobId = normalizeHostHookString(job.id);
		const sessionKey = normalizeHostHookString(job.sessionKey);
		const kind = normalizeHostHookString(job.kind);
		if (jobId && (registry.sessionSchedulerJobs ?? []).some((entry) => entry.pluginId === record.id && entry.job.id === jobId)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session scheduler job already registered: ${jobId}`
			});
			return;
		}
		if (!jobId || !sessionKey || !kind) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "session scheduler job registration requires unique id, sessionKey, and kind"
			});
			return;
		}
		if (job.cleanup !== void 0 && typeof job.cleanup !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session scheduler job cleanup must be a function: ${jobId}`
			});
			return;
		}
		if (registryParams.activateGlobalSideEffects === false) {
			(registry.sessionSchedulerJobs ??= []).push({
				pluginId: record.id,
				pluginName: record.name,
				job: {
					...job,
					id: jobId,
					sessionKey,
					kind
				},
				source: record.source,
				rootDir: record.rootDir
			});
			return {
				id: jobId,
				pluginId: record.id,
				sessionKey,
				kind
			};
		}
		const handle = registerPluginSessionSchedulerJob({
			pluginId: record.id,
			pluginName: record.name,
			ownerRegistry: registry,
			job: {
				...job,
				id: jobId,
				sessionKey,
				kind
			}
		});
		if (!handle) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "session scheduler job registration requires unique id, sessionKey, and kind"
			});
			return;
		}
		(registry.sessionSchedulerJobs ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			job: {
				...job,
				id: handle.id,
				sessionKey: handle.sessionKey,
				kind: handle.kind
			},
			generation: getPluginSessionSchedulerJobGeneration({
				pluginId: record.id,
				jobId: handle.id,
				sessionKey: handle.sessionKey
			}),
			source: record.source,
			rootDir: record.rootDir
		});
		return handle;
	};
	const registerSessionAction = (record, action) => {
		const id = normalizeHostHookString(action.id);
		const description = normalizeOptionalHostHookString(action.description);
		const requiredScopes = normalizeHostHookStringList(action.requiredScopes);
		if (!id || description === "" || requiredScopes === null || typeof action.handler !== "function") {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: "session action registration requires id, handler, and valid optional fields"
			});
			return;
		}
		if (requiredScopes !== void 0) {
			const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
			if (unknownScope !== void 0) {
				pushDiagnostic({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: `session action requiredScopes contains unknown operator scope: ${unknownScope}`
				});
				return;
			}
		}
		if (!validateSessionActionSchema(record, id, action.schema)) return;
		if ((registry.sessionActions ?? []).find((entry) => entry.pluginId === record.id && entry.action.id === id)) {
			pushDiagnostic({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: `session action already registered: ${id}`
			});
			return;
		}
		(registry.sessionActions ??= []).push({
			pluginId: record.id,
			pluginName: record.name,
			action: {
				...action,
				id,
				...description !== void 0 ? { description } : {},
				...requiredScopes !== void 0 ? { requiredScopes } : {}
			},
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const registerTypedHook = (record, hookName, handler, opts, policy) => {
		if (!isPluginHookName(hookName)) {
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: `unknown typed hook "${String(hookName)}" ignored`
			});
			return;
		}
		const effectiveHookName = hookName === "deactivate" ? "gateway_stop" : hookName;
		if (hookName === "deactivate") pushDiagnostic({
			level: "warn",
			pluginId: record.id,
			source: record.source,
			message: formatLegacyDeactivateHookAliasDiagnostic()
		});
		let effectiveHandler = handler;
		if (policy?.allowPromptInjection === false && isPromptInjectionHookName(effectiveHookName)) {
			if (effectiveHookName !== "before_agent_start") {
				pushDiagnostic({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: `typed hook "${effectiveHookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`
				});
				return;
			}
			pushDiagnostic({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: `typed hook "${effectiveHookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`
			});
			effectiveHandler = constrainLegacyPromptInjectionHook(handler);
		}
		if (isConversationHookName(effectiveHookName)) {
			const explicitConversationAccess = policy?.allowConversationAccess;
			if (record.origin !== "bundled" && explicitConversationAccess !== true) {
				pushDiagnostic({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: `typed hook "${effectiveHookName}" blocked because non-bundled plugins must set plugins.entries.${record.id}.hooks.allowConversationAccess=true`
				});
				return;
			}
			if (record.origin === "bundled" && explicitConversationAccess === false) {
				pushDiagnostic({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: `typed hook "${effectiveHookName}" blocked by plugins.entries.${record.id}.hooks.allowConversationAccess=false`
				});
				return;
			}
		}
		const timeoutMs = resolveTypedHookTimeoutMs({
			hookName: effectiveHookName,
			opts,
			policy
		});
		record.hookCount += 1;
		registry.typedHooks.push({
			pluginId: record.id,
			hookName: effectiveHookName,
			handler: effectiveHandler,
			priority: opts?.priority,
			...timeoutMs !== void 0 ? { timeoutMs } : {},
			source: record.source
		});
	};
	const registerConversationBindingResolvedHandler = (record, handler) => {
		registry.conversationBindingResolvedHandlers.push({
			pluginId: record.id,
			pluginName: record.name,
			pluginRoot: record.rootDir,
			handler,
			source: record.source,
			rootDir: record.rootDir
		});
	};
	const normalizeLogger = (logger) => ({
		info: logger.info,
		warn: logger.warn,
		error: logger.error,
		debug: logger.debug
	});
	const pluginRuntimeById = /* @__PURE__ */ new Map();
	const pluginRuntimeRecordById = /* @__PURE__ */ new Map();
	const resolvePluginRuntime = (pluginId) => {
		const cached = pluginRuntimeById.get(pluginId);
		if (cached) return cached;
		const runtime = new Proxy(registryParams.runtime, { get(target, prop, receiver) {
			const runWithPluginScope = (run) => {
				const record = pluginRuntimeRecordById.get(pluginId) ?? registry.plugins.find((entry) => entry.id === pluginId);
				return record?.source ? withPluginRuntimePluginScope({
					pluginId,
					pluginSource: record.source
				}, run) : withPluginRuntimePluginScope({ pluginId }, run);
			};
			if (prop === "state") return {
				...Reflect.get(target, prop, receiver),
				openKeyedStore: (options) => {
					const record = pluginRuntimeRecordById.get(pluginId) ?? registry.plugins.find((entry) => entry.id === pluginId);
					if (record?.origin !== "bundled" && record?.trustedOfficialInstall !== true) throw new Error("openKeyedStore is only available for trusted plugins in this release.");
					return createPluginStateKeyedStore(pluginId, options);
				}
			};
			if (prop === "config") {
				const config = Reflect.get(target, prop, receiver);
				return {
					...config,
					current: () => runWithPluginScope(() => config.current()),
					mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
					replaceConfigFile: (params) => runWithPluginScope(() => config.replaceConfigFile(params))
				};
			}
			if (prop === "llm") {
				const llm = Reflect.get(target, prop, receiver);
				return { complete: (params) => withPluginRuntimePluginIdScope(pluginId, () => llm.complete(params)) };
			}
			if (prop !== "subagent") return Reflect.get(target, prop, receiver);
			const subagent = Reflect.get(target, prop, receiver);
			return {
				run: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params)),
				waitForRun: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
				getSessionMessages: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
				getSession: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.getSession(params)),
				deleteSession: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.deleteSession(params))
			};
		} });
		pluginRuntimeById.set(pluginId, runtime);
		return runtime;
	};
	const createApi = (record, params) => {
		const registrationMode = params.registrationMode ?? "full";
		const registrationCapabilities = resolvePluginRegistrationCapabilities(registrationMode);
		pluginRuntimeRecordById.set(record.id, record);
		const sideEffectGuard = createPluginSideEffectGuard(record.id);
		const isLoadedRecordInRegistry = () => registry.plugins.some((plugin) => plugin.id === record.id && plugin.status === "loaded");
		const isLoadedRecordInActiveRegistry = () => getActivePluginRegistry() === registry && isLoadedRecordInRegistry();
		const isActivatingLoadedRecord = () => registryParams.activateGlobalSideEffects !== false && record.enabled && record.status === "loaded" && !registry.plugins.some((plugin) => plugin.id === record.id);
		const shouldCommitWorkflowSideEffect = () => sideEffectGuard.active && !isPluginRegistryRetired(registry) && (isActivatingLoadedRecord() || isPluginRegistryActivated(registry) && isLoadedRecordInRegistry());
		return buildPluginApi({
			id: record.id,
			name: record.name,
			version: record.version,
			description: record.description,
			source: record.source,
			rootDir: record.rootDir,
			registrationMode,
			config: params.config,
			pluginConfig: params.pluginConfig,
			runtime: resolvePluginRuntime(record.id),
			logger: normalizeLogger(registryParams.logger),
			resolvePath: (input) => resolvePluginPath(input, record.rootDir),
			handlers: {
				...registrationCapabilities.capabilityHandlers ? {
					registerTool: (tool, opts) => registerTool(record, tool, opts),
					registerHook: (events, handler, opts) => registerHook(record, events, handler, opts, params.config, params.pluginConfig),
					registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
					registerHostedMediaResolver: (resolver) => registerHostedMediaResolver(record, resolver),
					registerProvider: (provider) => registerProvider(record, provider),
					registerModelCatalogProvider: (provider) => registerModelCatalogProvider(record, provider),
					registerEmbeddingProvider: (provider) => registerEmbeddingProviderForPlugin(record, provider),
					registerAgentHarness: (harness) => registerAgentHarness$1(record, harness),
					registerDetachedTaskRuntime: (runtime) => {
						const existing = getDetachedTaskLifecycleRuntimeRegistration();
						if (existing && existing.pluginId !== record.id) {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `detached task runtime already registered by ${existing.pluginId}`
							});
							return;
						}
						registerDetachedTaskLifecycleRuntime(record.id, runtime);
					},
					registerSpeechProvider: (provider) => registerSpeechProvider(record, provider),
					registerRealtimeTranscriptionProvider: (provider) => registerRealtimeTranscriptionProvider(record, provider),
					registerRealtimeVoiceProvider: (provider) => registerRealtimeVoiceProvider(record, provider),
					registerMediaUnderstandingProvider: (provider) => registerMediaUnderstandingProvider(record, provider),
					registerImageGenerationProvider: (provider) => registerImageGenerationProvider(record, provider),
					registerVideoGenerationProvider: (provider) => registerVideoGenerationProvider(record, provider),
					registerMusicGenerationProvider: (provider) => registerMusicGenerationProvider(record, provider),
					registerWebFetchProvider: (provider) => registerWebFetchProvider(record, provider),
					registerWebSearchProvider: (provider) => registerWebSearchProvider(record, provider),
					registerMigrationProvider: (provider) => registerMigrationProvider(record, provider),
					registerGatewayMethod: (method, handler, opts) => registerGatewayMethod(record, method, handler, opts),
					registerService: (service) => registerService(record, service),
					registerGatewayDiscoveryService: (service) => registerGatewayDiscoveryService(record, service),
					registerCliBackend: (backend) => registerCliBackend(record, backend),
					registerTextTransforms: (transforms) => registerTextTransforms(record, transforms),
					registerReload: (registration) => registerReload(record, registration),
					registerNodeHostCommand: (command) => registerNodeHostCommand(record, command),
					registerNodeInvokePolicy: (policy) => registerNodeInvokePolicy(record, policy, params.pluginConfig),
					registerSecurityAuditCollector: (collector) => registerSecurityAuditCollector(record, collector),
					registerInteractiveHandler: (registration) => {
						const result = registerPluginInteractiveHandler(record.id, registration, {
							pluginName: record.name,
							pluginRoot: record.rootDir
						});
						if (!result.ok) pushDiagnostic({
							level: "warn",
							pluginId: record.id,
							source: record.source,
							message: result.error ?? "interactive handler registration failed"
						});
					},
					onConversationBindingResolved: (handler) => registerConversationBindingResolvedHandler(record, handler),
					registerCommand: (command) => registerCommand(record, command),
					registerContextEngine: (id, factory) => {
						const normalizedId = normalizeOptionalString(id) ?? "";
						if (!normalizedId) {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: "context engine registration missing id"
							});
							return;
						}
						if (typeof factory !== "function") {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `context engine "${normalizedId}" registration missing factory`
							});
							return;
						}
						if (normalizedId === defaultSlotIdForKey("contextEngine")) {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `context engine id reserved by core: ${normalizedId}`
							});
							return;
						}
						const result = registerContextEngineForOwner(normalizedId, factory, `plugin:${record.id}`, { allowSameOwnerRefresh: true });
						if (!result.ok) {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `context engine already registered: ${normalizedId} (${result.existingOwner})`
							});
							return;
						}
						if (!record.contextEngineIds?.includes(normalizedId)) record.contextEngineIds = [...record.contextEngineIds ?? [], normalizedId];
					},
					registerCompactionProvider: (provider) => {
						const id = normalizeOptionalString(provider?.id);
						if (!id) {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: "compaction provider registration missing id"
							});
							return;
						}
						if (typeof provider?.summarize !== "function") {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `compaction provider "${id}" registration missing summarize`
							});
							return;
						}
						const existing = getRegisteredCompactionProvider(id);
						if (existing) {
							const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `compaction provider already registered: ${id}${ownerDetail}`
							});
							return;
						}
						registerCompactionProvider(provider, { ownerPluginId: record.id });
					},
					registerCodexAppServerExtensionFactory: (factory) => {
						registerCodexAppServerExtensionFactory(record, factory);
					},
					registerAgentToolResultMiddleware: (handler, options) => {
						registerAgentToolResultMiddleware(record, handler, options);
					},
					registerSessionExtension: (extension) => registerSessionExtension(record, extension),
					enqueueNextTurnInjection: (injection) => {
						if (params.hookPolicy?.allowPromptInjection === false) {
							pushDiagnostic({
								level: "warn",
								pluginId: record.id,
								source: record.source,
								message: `next-turn injection blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`
							});
							return Promise.resolve({
								enqueued: false,
								id: "",
								sessionKey: injection.sessionKey
							});
						}
						return enqueuePluginNextTurnInjection({
							cfg: registryParams.runtime.config.current(),
							pluginId: record.id,
							pluginName: record.name,
							injection
						});
					},
					registerTrustedToolPolicy: (policy) => registerTrustedToolPolicy(record, policy),
					registerToolMetadata: (metadata) => registerToolMetadata(record, metadata),
					registerControlUiDescriptor: (descriptor) => registerControlUiDescriptor(record, descriptor),
					registerRuntimeLifecycle: (lifecycle) => registerRuntimeLifecycle(record, lifecycle),
					registerAgentEventSubscription: (subscription) => registerAgentEventSubscription(record, subscription),
					emitAgentEvent: (event) => {
						if (registryParams.activateGlobalSideEffects === false) return {
							emitted: false,
							reason: "global side effects disabled"
						};
						if (!shouldCommitWorkflowSideEffect()) return {
							emitted: false,
							reason: "plugin is not loaded"
						};
						return emitPluginAgentEvent({
							pluginId: record.id,
							pluginName: record.name,
							origin: record.origin,
							event
						});
					},
					setRunContext: (patch) => registryParams.activateGlobalSideEffects !== false && shouldCommitWorkflowSideEffect() ? setPluginRunContext({
						pluginId: record.id,
						patch
					}) : false,
					getRunContext: (get) => getPluginRunContext({
						pluginId: record.id,
						get
					}),
					clearRunContext: (params) => {
						if (registryParams.activateGlobalSideEffects === false || !shouldCommitWorkflowSideEffect()) return;
						clearPluginRunContext({
							pluginId: record.id,
							runId: params.runId,
							namespace: params.namespace
						});
					},
					registerSessionSchedulerJob: (job) => registerSessionSchedulerJob(record, job),
					registerSessionAction: (action) => registerSessionAction(record, action),
					sendSessionAttachment: async (attachment) => {
						if (registryParams.activateGlobalSideEffects === false) return {
							ok: false,
							error: "global side effects disabled"
						};
						try {
							if (!isLoadedRecordInActiveRegistry()) return {
								ok: false,
								error: "plugin is not loaded"
							};
							const runtimeConfig = registryParams.runtime.config?.current?.() ?? params.config;
							return await sendPluginSessionAttachment({
								...attachment,
								config: runtimeConfig,
								origin: record.origin
							});
						} catch (error) {
							return {
								ok: false,
								error: `attachment delivery setup failed: ${formatErrorMessage(error)}`
							};
						}
					},
					scheduleSessionTurn: async (schedule) => {
						if (registryParams.activateGlobalSideEffects === false) return;
						await Promise.resolve();
						return schedulePluginSessionTurn({
							pluginId: record.id,
							pluginName: record.name,
							origin: record.origin,
							schedule,
							cron: getHostCronService(),
							shouldCommit: isLoadedRecordInActiveRegistry,
							ownerRegistry: registry
						});
					},
					unscheduleSessionTurnsByTag: async (request) => {
						if (registryParams.activateGlobalSideEffects === false) return {
							removed: 0,
							failed: 0
						};
						await Promise.resolve();
						if (!isLoadedRecordInActiveRegistry()) return {
							removed: 0,
							failed: 0
						};
						return unschedulePluginSessionTurnsByTag({
							pluginId: record.id,
							origin: record.origin,
							cron: getHostCronService(),
							request
						});
					},
					registerMemoryCapability: (capability) => {
						if (!hasKind(record.kind, "memory")) throwRegistrationError("only memory plugins can register a memory capability");
						if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
							pushDiagnostic({
								level: "warn",
								pluginId: record.id,
								source: record.source,
								message: "dual-kind plugin not selected for memory slot; skipping memory capability registration"
							});
							return;
						}
						registerMemoryCapability(record.id, capability);
					},
					registerMemoryPromptSection: (builder) => {
						if (!hasKind(record.kind, "memory")) throwRegistrationError("only memory plugins can register a memory prompt section");
						if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
							pushDiagnostic({
								level: "warn",
								pluginId: record.id,
								source: record.source,
								message: "dual-kind plugin not selected for memory slot; skipping memory prompt section registration"
							});
							return;
						}
						registerMemoryPromptSectionForPlugin(record.id, builder);
					},
					registerMemoryPromptSupplement: (builder) => {
						if (typeof builder !== "function") {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: "memory prompt supplement registration missing builder"
							});
							return;
						}
						registerMemoryPromptSupplement(record.id, builder);
					},
					registerMemoryCorpusSupplement: (supplement) => {
						registerMemoryCorpusSupplement(record.id, supplement);
					},
					registerMemoryFlushPlan: (resolver) => {
						if (!hasKind(record.kind, "memory")) throwRegistrationError("only memory plugins can register a memory flush plan");
						if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
							pushDiagnostic({
								level: "warn",
								pluginId: record.id,
								source: record.source,
								message: "dual-kind plugin not selected for memory slot; skipping memory flush plan registration"
							});
							return;
						}
						registerMemoryFlushPlanResolverForPlugin(record.id, resolver);
					},
					registerMemoryRuntime: (runtime) => {
						if (!hasKind(record.kind, "memory")) throwRegistrationError("only memory plugins can register a memory runtime");
						if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
							pushDiagnostic({
								level: "warn",
								pluginId: record.id,
								source: record.source,
								message: "dual-kind plugin not selected for memory slot; skipping memory runtime registration"
							});
							return;
						}
						registerMemoryRuntimeForPlugin(record.id, runtime);
					},
					registerMemoryEmbeddingProvider: (adapter) => {
						if (hasKind(record.kind, "memory")) {
							if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
								pushDiagnostic({
									level: "warn",
									pluginId: record.id,
									source: record.source,
									message: "dual-kind plugin not selected for memory slot; skipping memory embedding provider registration"
								});
								return;
							}
						} else if (!(record.contracts?.memoryEmbeddingProviders ?? []).includes(adapter.id)) {
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`
							});
							return;
						}
						const existing = getRegisteredMemoryEmbeddingProvider(adapter.id);
						if (existing) {
							const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
							pushDiagnostic({
								level: "error",
								pluginId: record.id,
								source: record.source,
								message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`
							});
							return;
						}
						registerMemoryEmbeddingProvider(adapter, { ownerPluginId: record.id });
						registry.memoryEmbeddingProviders.push({
							pluginId: record.id,
							pluginName: record.name,
							provider: adapter,
							source: record.source,
							rootDir: record.rootDir
						});
					},
					on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts, params.hookPolicy)
				} : {},
				registerCli: (registrar, opts) => registerCli(record, registrar, opts),
				registerChannel: (registration) => registerChannel(record, registration, registrationMode)
			}
		});
	};
	const rollbackPluginGlobalSideEffects = (pluginId) => {
		deactivatePluginSideEffectGuards(pluginId);
		if (registryParams.activateGlobalSideEffects === false) return;
		clearPluginCommandsForPlugin(pluginId);
		clearPluginInteractiveHandlersForPlugin(pluginId);
		clearContextEnginesForOwner(`plugin:${pluginId}`);
		const hookRollbackEntries = pluginHookRollback.get(pluginId) ?? [];
		for (const entry of hookRollbackEntries.toReversed()) {
			const activeRegistrations = activePluginHookRegistrations.get(entry.name) ?? [];
			for (const registration of activeRegistrations) unregisterInternalHook(registration.event, registration.handler);
			if (entry.previousRegistrations.length === 0) {
				activePluginHookRegistrations.delete(entry.name);
				continue;
			}
			for (const registration of entry.previousRegistrations) registerInternalHook(registration.event, registration.handler);
			activePluginHookRegistrations.set(entry.name, [...entry.previousRegistrations]);
		}
		pluginHookRollback.delete(pluginId);
	};
	return {
		registry,
		createApi,
		rollbackPluginGlobalSideEffects,
		pushDiagnostic,
		registerTool,
		registerChannel,
		registerHostedMediaResolver,
		registerProvider,
		registerModelCatalogProvider,
		registerAgentHarness: registerAgentHarness$1,
		registerCliBackend,
		registerTextTransforms,
		registerEmbeddingProvider: registerEmbeddingProviderForPlugin,
		registerSpeechProvider,
		registerRealtimeTranscriptionProvider,
		registerRealtimeVoiceProvider,
		registerMediaUnderstandingProvider,
		registerImageGenerationProvider,
		registerVideoGenerationProvider,
		registerMusicGenerationProvider,
		registerWebSearchProvider,
		registerMigrationProvider,
		registerGatewayMethod,
		registerCli,
		registerReload,
		registerNodeHostCommand,
		registerSecurityAuditCollector,
		registerService,
		registerCommand,
		registerSessionExtension,
		registerTrustedToolPolicy,
		registerToolMetadata,
		registerControlUiDescriptor,
		registerRuntimeLifecycle,
		registerAgentEventSubscription,
		registerSessionSchedulerJob,
		registerSessionAction,
		registerHook,
		registerTypedHook
	};
}
//#endregion
//#region src/plugins/loader.ts
function detailPluginStartupTrace(startupTrace, pluginId, metrics) {
	startupTrace?.detail(`plugins.gateway-load.plugin.${encodeStartupTraceSegment(pluginId)}`, metrics);
}
const CLI_METADATA_ENTRY_BASENAMES = [
	"cli-metadata.ts",
	"cli-metadata.js",
	"cli-metadata.mjs",
	"cli-metadata.cjs"
];
function resolveDreamingSidecarEngineId(params) {
	const normalizedMemorySlot = normalizeLowercaseStringOrEmpty(params.memorySlot);
	if (!normalizedMemorySlot || normalizedMemorySlot === "none" || normalizedMemorySlot === "memory-core") return null;
	return resolveMemoryDreamingConfig({
		pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
		cfg: params.cfg
	}).enabled ? DEFAULT_MEMORY_DREAMING_PLUGIN_ID : null;
}
var PluginLoadFailureError = class extends Error {
	constructor(registry) {
		const failedPlugins = registry.plugins.filter((entry) => entry.status === "error");
		const summary = failedPlugins.map((entry) => `${entry.id}: ${entry.error ?? "unknown plugin load error"}`).join("; ");
		super(`plugin load failed: ${summary}`);
		this.name = "PluginLoadFailureError";
		this.pluginIds = failedPlugins.map((entry) => entry.id);
		this.registry = registry;
	}
};
const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;
const pluginLoaderCacheState = new PluginLoaderCacheState(MAX_PLUGIN_REGISTRY_CACHE_ENTRIES);
const fullWorkspacePluginLoaderCacheState = new PluginLoaderCacheState(MAX_PLUGIN_REGISTRY_CACHE_ENTRIES);
const LAZY_RUNTIME_REFLECTION_KEYS = [
	"version",
	"config",
	"agent",
	"subagent",
	"system",
	"media",
	"tts",
	"stt",
	"channel",
	"events",
	"logging",
	"state",
	"modelAuth"
];
function createPluginCandidatesFromManifestRegistry(manifestRegistry) {
	return manifestRegistry.plugins.map((record) => ({
		idHint: record.id,
		rootDir: record.rootDir,
		source: record.source,
		...record.setupSource !== void 0 ? { setupSource: record.setupSource } : {},
		origin: record.origin,
		...record.workspaceDir !== void 0 ? { workspaceDir: record.workspaceDir } : {},
		...record.format !== void 0 ? { format: record.format } : {},
		...record.bundleFormat !== void 0 ? { bundleFormat: record.bundleFormat } : {}
	}));
}
function clearPluginLoaderCache() {
	pluginLoaderCacheState.clear();
	fullWorkspacePluginLoaderCacheState.clear();
	clearActivatedPluginRuntimeState();
}
function clearActivatedPluginRuntimeState() {
	clearAgentHarnesses();
	clearPluginCommands();
	clearCompactionProviders();
	clearDetachedTaskLifecycleRuntimeRegistration();
	clearPluginInteractiveHandlers();
	clearEmbeddingProviders();
	clearMemoryEmbeddingProviders();
	clearMemoryPluginState();
}
function clearPluginRegistryLoadCache() {
	pluginLoaderCacheState.clearCachedRegistries();
	fullWorkspacePluginLoaderCacheState.clearCachedRegistries();
}
const defaultLogger = () => createSubsystemLogger("plugins");
function isPromiseLike(value) {
	return (typeof value === "object" || typeof value === "function") && value !== null && typeof value.then === "function";
}
function snapshotPluginRegistry(registry) {
	return {
		arrays: {
			tools: [...registry.tools],
			hooks: [...registry.hooks],
			typedHooks: [...registry.typedHooks],
			channels: [...registry.channels],
			channelSetups: [...registry.channelSetups],
			providers: [...registry.providers],
			modelCatalogProviders: [...registry.modelCatalogProviders],
			cliBackends: [...registry.cliBackends ?? []],
			textTransforms: [...registry.textTransforms],
			embeddingProviders: [...registry.embeddingProviders],
			speechProviders: [...registry.speechProviders],
			realtimeTranscriptionProviders: [...registry.realtimeTranscriptionProviders],
			realtimeVoiceProviders: [...registry.realtimeVoiceProviders],
			mediaUnderstandingProviders: [...registry.mediaUnderstandingProviders],
			imageGenerationProviders: [...registry.imageGenerationProviders],
			videoGenerationProviders: [...registry.videoGenerationProviders],
			musicGenerationProviders: [...registry.musicGenerationProviders],
			webFetchProviders: [...registry.webFetchProviders],
			webSearchProviders: [...registry.webSearchProviders],
			migrationProviders: [...registry.migrationProviders],
			codexAppServerExtensionFactories: [...registry.codexAppServerExtensionFactories],
			agentToolResultMiddlewares: [...registry.agentToolResultMiddlewares],
			memoryEmbeddingProviders: [...registry.memoryEmbeddingProviders],
			agentHarnesses: [...registry.agentHarnesses],
			httpRoutes: [...registry.httpRoutes],
			cliRegistrars: [...registry.cliRegistrars],
			reloads: [...registry.reloads ?? []],
			nodeHostCommands: [...registry.nodeHostCommands ?? []],
			nodeInvokePolicies: [...registry.nodeInvokePolicies ?? []],
			securityAuditCollectors: [...registry.securityAuditCollectors ?? []],
			services: [...registry.services],
			commands: [...registry.commands],
			sessionActions: [...registry.sessionActions ?? []],
			conversationBindingResolvedHandlers: [...registry.conversationBindingResolvedHandlers],
			diagnostics: [...registry.diagnostics]
		},
		gatewayHandlers: { ...registry.gatewayHandlers },
		gatewayMethodDescriptors: [...registry.gatewayMethodDescriptors],
		coreGatewayMethodNames: [...registry.coreGatewayMethodNames ?? []]
	};
}
function restorePluginRegistry(registry, snapshot) {
	registry.tools = snapshot.arrays.tools;
	registry.hooks = snapshot.arrays.hooks;
	registry.typedHooks = snapshot.arrays.typedHooks;
	registry.channels = snapshot.arrays.channels;
	registry.channelSetups = snapshot.arrays.channelSetups;
	registry.providers = snapshot.arrays.providers;
	registry.modelCatalogProviders = snapshot.arrays.modelCatalogProviders;
	registry.cliBackends = snapshot.arrays.cliBackends;
	registry.textTransforms = snapshot.arrays.textTransforms;
	registry.embeddingProviders = snapshot.arrays.embeddingProviders;
	registry.speechProviders = snapshot.arrays.speechProviders;
	registry.realtimeTranscriptionProviders = snapshot.arrays.realtimeTranscriptionProviders;
	registry.realtimeVoiceProviders = snapshot.arrays.realtimeVoiceProviders;
	registry.mediaUnderstandingProviders = snapshot.arrays.mediaUnderstandingProviders;
	registry.imageGenerationProviders = snapshot.arrays.imageGenerationProviders;
	registry.videoGenerationProviders = snapshot.arrays.videoGenerationProviders;
	registry.musicGenerationProviders = snapshot.arrays.musicGenerationProviders;
	registry.webFetchProviders = snapshot.arrays.webFetchProviders;
	registry.webSearchProviders = snapshot.arrays.webSearchProviders;
	registry.migrationProviders = snapshot.arrays.migrationProviders;
	registry.codexAppServerExtensionFactories = snapshot.arrays.codexAppServerExtensionFactories;
	registry.agentToolResultMiddlewares = snapshot.arrays.agentToolResultMiddlewares;
	registry.memoryEmbeddingProviders = snapshot.arrays.memoryEmbeddingProviders;
	registry.agentHarnesses = snapshot.arrays.agentHarnesses;
	registry.httpRoutes = snapshot.arrays.httpRoutes;
	registry.cliRegistrars = snapshot.arrays.cliRegistrars;
	registry.reloads = snapshot.arrays.reloads;
	registry.nodeHostCommands = snapshot.arrays.nodeHostCommands;
	registry.nodeInvokePolicies = snapshot.arrays.nodeInvokePolicies;
	registry.securityAuditCollectors = snapshot.arrays.securityAuditCollectors;
	registry.services = snapshot.arrays.services;
	registry.commands = snapshot.arrays.commands;
	registry.sessionActions = snapshot.arrays.sessionActions;
	registry.conversationBindingResolvedHandlers = snapshot.arrays.conversationBindingResolvedHandlers;
	registry.diagnostics = snapshot.arrays.diagnostics;
	registry.gatewayHandlers = snapshot.gatewayHandlers;
	registry.gatewayMethodDescriptors = snapshot.gatewayMethodDescriptors;
	registry.coreGatewayMethodNames = snapshot.coreGatewayMethodNames;
}
function createGuardedPluginRegistrationApi(api) {
	let closed = false;
	return {
		api: attachPluginApiFacades(new Proxy(api, { get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			if (typeof prop === "string" && isLateCallablePluginApiMethod(prop)) return (...args) => Reflect.apply(value, target, args);
			return (...args) => {
				const isLateCallableMethod = typeof prop === "string" && isLateCallablePluginApiMethod(prop);
				if (closed && !isLateCallableMethod) return;
				return Reflect.apply(value, target, args);
			};
		} })),
		close: () => {
			closed = true;
		}
	};
}
function runPluginRegisterSync(register, api) {
	const guarded = createGuardedPluginRegistrationApi(api);
	try {
		const result = register(guarded.api);
		if (isPromiseLike(result)) {
			Promise.resolve(result).catch(() => {});
			throw new Error("plugin register must be synchronous");
		}
	} finally {
		guarded.close();
	}
}
function createPluginModuleLoader(options) {
	const moduleLoaders = createPluginModuleLoaderCache();
	const createLoaderForModule = (modulePath) => {
		installOpenClawPluginSdkNativeResolver({
			argv1: process.argv[1],
			moduleUrl: import.meta.url,
			pluginModulePath: modulePath,
			pluginSdkResolution: options.pluginSdkResolution
		});
		return getCachedPluginModuleLoader({
			cache: moduleLoaders,
			modulePath,
			importerUrl: import.meta.url,
			loaderFilename: modulePath,
			aliasMap: buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url, options.pluginSdkResolution),
			pluginSdkResolution: options.pluginSdkResolution
		});
	};
	return (modulePath) => createLoaderForModule(modulePath)(toSafeImportPath(modulePath));
}
function resolveCanonicalDistRuntimeSource(source) {
	const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
	const index = source.indexOf(marker);
	if (index === -1) return source;
	const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
	return fs.existsSync(candidate) ? candidate : source;
}
function rewriteBundledRuntimeArtifactRelativePath(relativePath) {
	return relativePath.replace(/\.[^.]+$/u, ".js");
}
function resolvePreferredBuiltBundledRuntimeArtifact(params) {
	const rootDir = safeRealpathOrResolve(params.rootDir);
	const source = safeRealpathOrResolve(params.source);
	if (!params.preferBuiltPluginArtifacts || params.origin !== "bundled") return {
		source,
		rootDir
	};
	const extensionsDir = path.dirname(rootDir);
	if (path.basename(extensionsDir) !== "extensions") return {
		source,
		rootDir
	};
	const packageRoot = path.dirname(extensionsDir);
	if (path.basename(packageRoot) === "dist" || path.basename(packageRoot) === "dist-runtime") return {
		source,
		rootDir
	};
	const relativeSource = path.relative(rootDir, source);
	if (relativeSource === "" || relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) return {
		source,
		rootDir
	};
	const artifactRelativePath = rewriteBundledRuntimeArtifactRelativePath(relativeSource);
	for (const artifactRootName of ["dist-runtime", "dist"]) {
		const artifactRoot = path.join(packageRoot, artifactRootName, "extensions", path.basename(rootDir));
		const artifactSource = path.join(artifactRoot, artifactRelativePath);
		if (fs.existsSync(artifactSource)) return {
			source: safeRealpathOrResolve(artifactSource),
			rootDir: safeRealpathOrResolve(artifactRoot)
		};
	}
	return {
		source,
		rootDir
	};
}
const testing = {
	buildPluginLoaderJitiOptions,
	buildPluginLoaderAliasMap,
	listPluginSdkAliasCandidates,
	listPluginSdkExportedSubpaths,
	resolveExtensionApiAlias,
	resolvePluginSdkScopedAliasMap,
	resolvePluginSdkAliasCandidateOrder,
	resolvePluginSdkAliasFile,
	resolvePluginRuntimeModulePath,
	ensureOpenClawPluginSdkAlias,
	shouldLoadChannelPluginInSetupRuntime,
	shouldPreferNativeModuleLoad,
	toSafeImportPath,
	createGuardedPluginRegistrationApi,
	runPluginRegisterSync,
	getCompatibleActivePluginRegistry,
	resolvePluginLoadCacheContext,
	get maxPluginRegistryCacheEntries() {
		return pluginLoaderCacheState.maxEntries;
	},
	setMaxPluginRegistryCacheEntriesForTest(value) {
		pluginLoaderCacheState.setMaxEntriesForTest(value);
		fullWorkspacePluginLoaderCacheState.setMaxEntriesForTest(value);
	}
};
function getPluginRegistryCache(onlyPluginIds) {
	return onlyPluginIds ? pluginLoaderCacheState : fullWorkspacePluginLoaderCacheState;
}
function getCachedPluginRegistry(cacheKey, onlyPluginIds) {
	return getPluginRegistryCache(onlyPluginIds).get(cacheKey);
}
function setCachedPluginRegistry(cacheKey, state, onlyPluginIds) {
	getPluginRegistryCache(onlyPluginIds).set(cacheKey, state);
}
function getReusableCachedPluginRegistry(params) {
	const exact = getCachedPluginRegistry(params.cacheKey, params.onlyPluginIds);
	if (exact) return {
		state: exact,
		cacheKey: params.cacheKey,
		runtimeSubagentMode: params.runtimeSubagentMode
	};
	if (params.runtimeSubagentMode !== "default") return;
	const gatewayBindableContext = resolvePluginLoadCacheContext({
		...params.options,
		runtimeOptions: {
			...params.options.runtimeOptions,
			allowGatewaySubagentBinding: true
		}
	});
	const gatewayBindable = getCachedPluginRegistry(gatewayBindableContext.cacheKey, gatewayBindableContext.onlyPluginIds);
	if (!gatewayBindable) return;
	return {
		state: gatewayBindable,
		cacheKey: gatewayBindableContext.cacheKey,
		runtimeSubagentMode: gatewayBindableContext.runtimeSubagentMode
	};
}
function resolveBundledPackageRootForCache(stockRoot) {
	if (!stockRoot) return;
	const resolved = path.resolve(stockRoot);
	const parent = path.dirname(resolved);
	if (path.basename(resolved) === "extensions" && (path.basename(parent) === "dist" || path.basename(parent) === "dist-runtime")) return path.dirname(parent);
	const sourcePackageRoot = parent;
	if (fs.existsSync(path.join(sourcePackageRoot, "package.json"))) return sourcePackageRoot;
}
function readPackageVersionForCache(packageJsonPath) {
	const parsed = tryReadJsonSync(packageJsonPath);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
	const version = parsed.version;
	return typeof version === "string" && version.trim() ? version.trim() : "unknown";
}
const bundledPackageCacheIdentityByStockRoot = /* @__PURE__ */ new Map();
function resolveBundledPackageCacheIdentity(stockRoot) {
	if (!stockRoot) return;
	const packageRoot = resolveBundledPackageRootForCache(stockRoot);
	if (!packageRoot) return;
	const stockRootKey = path.resolve(stockRoot);
	const cached = bundledPackageCacheIdentityByStockRoot.get(stockRootKey);
	if (cached) return cached;
	const packageJsonPath = path.join(packageRoot, "package.json");
	try {
		const stat = fs.statSync(packageJsonPath);
		const identity = {
			packageJson: safeRealpathOrResolve(packageJsonPath),
			packageRoot: safeRealpathOrResolve(packageRoot),
			packageVersion: readPackageVersionForCache(packageJsonPath),
			size: stat.size,
			mtimeMs: stat.mtimeMs
		};
		bundledPackageCacheIdentityByStockRoot.set(stockRootKey, identity);
		return identity;
	} catch {
		const identity = {
			packageJson: path.resolve(packageJsonPath),
			packageRoot: safeRealpathOrResolve(packageRoot),
			packageVersion: "missing",
			size: -1,
			mtimeMs: -1
		};
		bundledPackageCacheIdentityByStockRoot.set(stockRootKey, identity);
		return identity;
	}
}
function buildCacheKey(params) {
	const discoveryContext = resolvePluginDiscoveryContext({
		workspaceDir: params.workspaceDir,
		loadPaths: params.plugins.loadPaths,
		env: params.env
	});
	const { roots, loadPaths } = discoveryContext;
	const bundledPackage = resolveBundledPackageCacheIdentity(roots.stock);
	const installs = Object.fromEntries(Object.entries(params.installs ?? {}).map(([pluginId, install]) => [pluginId, {
		...install,
		installPath: typeof install.installPath === "string" ? resolveUserPath(install.installPath, params.env) : install.installPath,
		sourcePath: typeof install.sourcePath === "string" ? resolveUserPath(install.sourcePath, params.env) : install.sourcePath
	}]));
	const scopeKey = serializePluginIdScope(params.onlyPluginIds);
	const setupOnlyKey = params.includeSetupOnlyChannelPlugins === true ? "setup-only" : "runtime";
	const setupOnlyModeKey = params.forceSetupOnlyChannelPlugins === true ? "force-setup" : "normal-setup";
	const setupOnlyRequirementKey = params.requireSetupEntryForSetupOnlyChannelPlugins === true ? "require-setup-entry" : "allow-full-fallback";
	const startupChannelMode = params.preferSetupRuntimeForChannelPlugins === true ? "prefer-setup" : "full";
	const bundledArtifactMode = params.preferBuiltPluginArtifacts === true ? "prefer-built-artifacts" : "source-default";
	const moduleLoadMode = params.loadModules === false ? "manifest-only" : "load-modules";
	const discoveryMode = params.toolDiscovery === true ? "tool-discovery" : "default-discovery";
	const runtimeSubagentMode = params.runtimeSubagentMode ?? "default";
	const gatewayMethodsKey = JSON.stringify(params.coreGatewayMethodNames ?? []);
	const activationMode = params.activate === false ? "snapshot" : "active";
	return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
		bundledPackage,
		discoveryFingerprint: fingerprintPluginDiscoveryContext(discoveryContext),
		...params.plugins,
		installs,
		loadPaths,
		activationMetadataKey: params.activationMetadataKey ?? ""
	})}::${scopeKey}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${startupChannelMode}::${bundledArtifactMode}::${moduleLoadMode}::${discoveryMode}::${runtimeSubagentMode}::${params.pluginSdkResolution ?? "auto"}::${gatewayMethodsKey}::${activationMode}`;
}
function matchesScopedPluginRequest(params) {
	const scopedIds = params.onlyPluginIdSet;
	if (!scopedIds) return true;
	return scopedIds.has(params.pluginId);
}
function resolveRuntimeSubagentMode(runtimeOptions) {
	if (runtimeOptions?.allowGatewaySubagentBinding === true) return "gateway-bindable";
	if (runtimeOptions?.subagent) return "explicit";
	return "default";
}
function buildActivationMetadataHash(params) {
	const enabledSourceChannels = Object.entries(params.activationSource.rootConfig?.channels ?? {}).filter(([, value]) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		return value.enabled === true;
	}).map(([channelId]) => channelId).toSorted((left, right) => left.localeCompare(right));
	const pluginEntryStates = Object.entries(params.activationSource.plugins.entries).map(([pluginId, entry]) => [pluginId, entry?.enabled ?? null]).toSorted(([left], [right]) => left.localeCompare(right));
	const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons).map(([pluginId, reasons]) => [pluginId, [...reasons]]).toSorted(([left], [right]) => left.localeCompare(right));
	return createHash("sha256").update(JSON.stringify({
		enabled: params.activationSource.plugins.enabled,
		allow: params.activationSource.plugins.allow,
		deny: params.activationSource.plugins.deny,
		memorySlot: params.activationSource.plugins.slots.memory,
		entries: pluginEntryStates,
		enabledChannels: enabledSourceChannels,
		autoEnabledReasons: autoEnableReasonEntries
	})).digest("hex");
}
function hasExplicitCompatibilityInputs(options) {
	return options.config !== void 0 || options.activationSourceConfig !== void 0 || options.autoEnabledReasons !== void 0 || options.workspaceDir !== void 0 || options.env !== void 0 || hasExplicitPluginIdScope(options.onlyPluginIds) || options.runtimeOptions !== void 0 || options.pluginSdkResolution !== void 0 || options.coreGatewayHandlers !== void 0 || options.includeSetupOnlyChannelPlugins === true || options.forceSetupOnlyChannelPlugins === true || options.requireSetupEntryForSetupOnlyChannelPlugins === true || options.preferSetupRuntimeForChannelPlugins === true || options.preferBuiltPluginArtifacts === true || options.loadModules === false;
}
function resolveCoreGatewayMethodNames(options) {
	const names = new Set(options.coreGatewayMethodNames ?? []);
	for (const name of Object.keys(options.coreGatewayHandlers ?? {})) names.add(name);
	return Array.from(names).toSorted();
}
function pluginLoadOptionsMatchCacheKey(options, expectedCacheKey) {
	return resolvePluginLoadCacheContext(options).cacheKey === expectedCacheKey;
}
function pluginToolDiscoveryOptionsMatchActiveCacheKey(options, expectedCacheKey) {
	if (options.toolDiscovery !== true) return false;
	const fullRuntimeOptions = {
		...options,
		toolDiscovery: void 0
	};
	if (pluginLoadOptionsMatchCacheKey(fullRuntimeOptions, expectedCacheKey)) return true;
	if (options.activate !== false) return false;
	return pluginLoadOptionsMatchCacheKey({
		...fullRuntimeOptions,
		activate: true
	}, expectedCacheKey);
}
function registryContainsPluginScope(registry, onlyPluginIds) {
	if (!onlyPluginIds || onlyPluginIds.length === 0) return false;
	const loadedPluginIds = new Set(registry.plugins.map((plugin) => plugin.id));
	return onlyPluginIds.every((pluginId) => loadedPluginIds.has(pluginId));
}
function scopedPluginLoadOptionsMatchWiderActiveCacheKey(options, expectedCacheKey, activeRegistry) {
	const { onlyPluginIds } = resolvePluginLoadCacheContext(options);
	if (!registryContainsPluginScope(activeRegistry, onlyPluginIds)) return false;
	return pluginLoadOptionsMatchCacheKey({
		...options,
		onlyPluginIds: void 0
	}, expectedCacheKey);
}
/**
* Convert loader intent into explicit behavior flags.
*
* Registration modes are plugin-facing labels; this plan is the internal source
* of truth for which entrypoint to load and which activation-only policies run.
*/
function resolvePluginRegistrationPlan(params) {
	if (params.canLoadScopedSetupOnlyChannelPlugin) return {
		mode: "setup-only",
		loadSetupEntry: true,
		loadSetupRuntimeEntry: false,
		runRuntimeCapabilityPolicy: false,
		runFullActivationOnlyRegistrations: false
	};
	if (params.scopedSetupOnlyChannelPluginRequested && params.requireSetupEntryForSetupOnlyChannelPlugins) return null;
	if (!params.enableStateEnabled) return null;
	if (params.toolDiscovery) return {
		mode: "tool-discovery",
		loadSetupEntry: false,
		loadSetupRuntimeEntry: false,
		runRuntimeCapabilityPolicy: true,
		runFullActivationOnlyRegistrations: false
	};
	if (params.shouldLoadModules && !params.validateOnly && shouldLoadChannelPluginInSetupRuntime({
		manifestChannels: params.manifestRecord.channels,
		setupSource: params.manifestRecord.setupSource,
		startupDeferConfiguredChannelFullLoadUntilAfterListen: params.manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
		cfg: params.cfg,
		env: params.env,
		preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins
	})) return {
		mode: "setup-runtime",
		loadSetupEntry: true,
		loadSetupRuntimeEntry: true,
		runRuntimeCapabilityPolicy: false,
		runFullActivationOnlyRegistrations: false
	};
	const mode = params.shouldActivate ? "full" : "discovery";
	return {
		mode,
		loadSetupEntry: false,
		loadSetupRuntimeEntry: false,
		runRuntimeCapabilityPolicy: true,
		runFullActivationOnlyRegistrations: mode === "full"
	};
}
function applyManifestSnapshotMetadata(record, manifestRecord) {
	record.channelIds = [...manifestRecord.channels ?? []];
	record.providerIds = [...manifestRecord.providers ?? []];
	record.cliBackendIds = [...manifestRecord.cliBackends ?? [], ...manifestRecord.setup?.cliBackends ?? []];
	record.commands = (manifestRecord.commandAliases ?? []).map((alias) => alias.name);
}
function resolvePluginLoadCacheContext(options = {}) {
	const env = options.env ?? process.env;
	const cfg = applyTestPluginDefaults(options.config ?? {}, env);
	const activationSourceConfig = resolvePluginActivationSourceConfig({
		config: options.config,
		activationSourceConfig: options.activationSourceConfig
	});
	const normalized = normalizePluginsConfig(cfg.plugins);
	const activationSource = createPluginActivationSource({ config: activationSourceConfig });
	const trustNormalized = mergeTrustPluginConfigFromActivationSource({
		normalized,
		activationSource
	});
	const onlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
	const includeSetupOnlyChannelPlugins = options.includeSetupOnlyChannelPlugins === true;
	const forceSetupOnlyChannelPlugins = options.forceSetupOnlyChannelPlugins === true;
	const requireSetupEntryForSetupOnlyChannelPlugins = options.requireSetupEntryForSetupOnlyChannelPlugins === true;
	const preferSetupRuntimeForChannelPlugins = options.preferSetupRuntimeForChannelPlugins === true;
	const preferBuiltPluginArtifacts = options.preferBuiltPluginArtifacts === true;
	const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
	const coreGatewayMethodNames = resolveCoreGatewayMethodNames(options);
	const installRecords = {
		...options.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({ env }),
		...cfg.plugins?.installs
	};
	const cacheKey = buildCacheKey({
		workspaceDir: options.workspaceDir,
		plugins: trustNormalized,
		activationMetadataKey: buildActivationMetadataHash({
			activationSource,
			autoEnabledReasons: options.autoEnabledReasons ?? {}
		}),
		installs: installRecords,
		env,
		onlyPluginIds,
		includeSetupOnlyChannelPlugins,
		forceSetupOnlyChannelPlugins,
		requireSetupEntryForSetupOnlyChannelPlugins,
		preferSetupRuntimeForChannelPlugins,
		preferBuiltPluginArtifacts,
		toolDiscovery: options.toolDiscovery,
		loadModules: options.loadModules,
		runtimeSubagentMode,
		pluginSdkResolution: options.pluginSdkResolution,
		...coreGatewayMethodNames !== void 0 && { coreGatewayMethodNames },
		activate: options.activate
	});
	return {
		env,
		cfg,
		normalized: trustNormalized,
		activationSourceConfig,
		activationSource,
		autoEnabledReasons: options.autoEnabledReasons ?? {},
		onlyPluginIds,
		includeSetupOnlyChannelPlugins,
		forceSetupOnlyChannelPlugins,
		requireSetupEntryForSetupOnlyChannelPlugins,
		preferSetupRuntimeForChannelPlugins,
		preferBuiltPluginArtifacts,
		shouldActivate: options.activate !== false,
		shouldLoadModules: options.loadModules !== false,
		runtimeSubagentMode,
		installRecords,
		cacheKey
	};
}
function mergeTrustPluginConfigFromActivationSource(params) {
	const source = params.activationSource.plugins;
	const allow = mergePluginTrustList(params.normalized.allow, source.allow);
	const deny = mergePluginTrustList(params.normalized.deny, source.deny);
	const loadPaths = mergePluginTrustList(params.normalized.loadPaths, source.loadPaths);
	if (allow === params.normalized.allow && deny === params.normalized.deny && loadPaths === params.normalized.loadPaths) return params.normalized;
	return {
		...params.normalized,
		allow,
		deny,
		loadPaths
	};
}
function mergePluginTrustList(runtimeList, sourceList) {
	if (sourceList.length === 0) return runtimeList;
	const merged = [...runtimeList];
	const seen = new Set(merged);
	for (const entry of sourceList) if (!seen.has(entry)) {
		merged.push(entry);
		seen.add(entry);
	}
	return merged.length === runtimeList.length ? runtimeList : merged;
}
function getCompatibleActivePluginRegistry(options = {}) {
	const activeRegistry = getActivePluginRegistry() ?? void 0;
	if (!activeRegistry) return;
	if (!hasExplicitCompatibilityInputs(options)) return activeRegistry;
	const activeCacheKey = getActivePluginRegistryKey();
	if (!activeCacheKey) return;
	const loadContext = resolvePluginLoadCacheContext(options);
	const matchesActiveCacheKey = (candidate) => {
		if (pluginLoadOptionsMatchCacheKey(candidate, activeCacheKey)) return true;
		if (candidate.coreGatewayMethodNames !== void 0) return false;
		return pluginLoadOptionsMatchCacheKey({
			...candidate,
			coreGatewayMethodNames: activeRegistry.coreGatewayMethodNames ?? []
		}, activeCacheKey);
	};
	const matchesCompatibleActiveRegistry = (candidate) => {
		if (matchesActiveCacheKey(candidate)) return true;
		if (scopedPluginLoadOptionsMatchWiderActiveCacheKey(candidate, activeCacheKey, activeRegistry)) return true;
		return pluginToolDiscoveryOptionsMatchActiveCacheKey(candidate, activeCacheKey);
	};
	if (matchesCompatibleActiveRegistry(options)) return activeRegistry;
	if (!loadContext.shouldActivate) {
		if (matchesCompatibleActiveRegistry({
			...options,
			activate: true
		})) return activeRegistry;
	}
	const activeRuntimeSubagentMode = getActivePluginRuntimeSubagentMode();
	if (activeRuntimeSubagentMode === "gateway-bindable") {
		if (matchesCompatibleActiveRegistry({
			...options,
			preferBuiltPluginArtifacts: true
		})) return activeRegistry;
		if (!loadContext.shouldActivate) {
			if (matchesCompatibleActiveRegistry({
				...options,
				activate: true,
				preferBuiltPluginArtifacts: true
			})) return activeRegistry;
		}
	}
	if (loadContext.runtimeSubagentMode === "default" && activeRuntimeSubagentMode === "gateway-bindable") {
		const gatewayBindableOptions = {
			...options,
			runtimeOptions: {
				...options.runtimeOptions,
				allowGatewaySubagentBinding: true
			}
		};
		const gatewayStartupOptions = {
			...gatewayBindableOptions,
			preferBuiltPluginArtifacts: true
		};
		if (!loadContext.shouldActivate) {
			const activatingGatewayBindableOptions = {
				...options,
				activate: true,
				runtimeOptions: {
					...options.runtimeOptions,
					allowGatewaySubagentBinding: true
				}
			};
			const activatingGatewayStartupOptions = {
				...activatingGatewayBindableOptions,
				preferBuiltPluginArtifacts: true
			};
			if (matchesCompatibleActiveRegistry(gatewayBindableOptions) || matchesCompatibleActiveRegistry(gatewayStartupOptions) || matchesCompatibleActiveRegistry(activatingGatewayBindableOptions) || matchesCompatibleActiveRegistry(activatingGatewayStartupOptions)) return activeRegistry;
		} else if (matchesCompatibleActiveRegistry(gatewayBindableOptions) || matchesCompatibleActiveRegistry(gatewayStartupOptions)) return activeRegistry;
	}
}
function resolveRuntimePluginRegistry(options) {
	if (!options || !hasExplicitCompatibilityInputs(options)) return getCompatibleActivePluginRegistry();
	const compatible = getCompatibleActivePluginRegistry(options);
	if (compatible) return compatible;
	if (isPluginRegistryLoadInFlight(options)) return;
	return loadOpenClawPlugins(options);
}
function getRuntimePluginRegistryForLoadOptions(options) {
	return resolveRuntimePluginRegistry(options);
}
function resolvePluginRegistryLoadCacheKey(options = {}) {
	return resolvePluginLoadCacheContext(options).cacheKey;
}
function isPluginRegistryLoadInFlight(options = {}) {
	return pluginLoaderCacheState.isLoadInFlight(resolvePluginRegistryLoadCacheKey(options));
}
function resolveCompatibleRuntimePluginRegistry(options) {
	return getCompatibleActivePluginRegistry(options);
}
function validatePluginConfig(params) {
	const schema = params.schema;
	if (!schema) return {
		ok: true,
		value: params.value
	};
	if (isEmptyPluginConfigJsonSchema(schema)) {
		if (params.value === void 0 || params.value && typeof params.value === "object" && !Array.isArray(params.value) && Object.keys(params.value).length === 0) return {
			ok: true,
			value: {}
		};
		if (!params.value || typeof params.value !== "object" || Array.isArray(params.value)) return {
			ok: false,
			errors: ["<root>: must be object"]
		};
		return {
			ok: false,
			errors: ["<root>: config must be empty"]
		};
	}
	const result = validateJsonSchemaValue({
		schema,
		cacheKey: params.cacheKey ?? JSON.stringify(schema),
		value: params.value ?? {},
		applyDefaults: true
	});
	if (result.ok) return {
		ok: true,
		value: result.value
	};
	return {
		ok: false,
		errors: result.errors.map((error) => error.text)
	};
}
function isEmptyPluginConfigJsonSchema(schema) {
	if (schema.type !== "object" || schema.additionalProperties !== false) return false;
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length > 0) return false;
	return !("required" in schema || "dependentRequired" in schema || "dependencies" in schema || "minProperties" in schema || "allOf" in schema || "anyOf" in schema || "oneOf" in schema || "not" in schema);
}
function resolvePluginModuleExport(moduleExport) {
	const seen = /* @__PURE__ */ new Set();
	const candidates = [unwrapDefaultModuleExport(moduleExport), moduleExport];
	for (let index = 0; index < candidates.length && index < 12; index += 1) {
		const resolved = candidates[index];
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		if (typeof resolved === "function") return { register: resolved };
		if (resolved && typeof resolved === "object") {
			const def = resolved;
			const register = def.register ?? def.activate;
			if (typeof register === "function") return {
				definition: def,
				register
			};
			for (const key of ["default", "module"]) if (key in def) candidates.push(def[key]);
		}
	}
	const resolved = candidates[0];
	if (typeof resolved === "function") return { register: resolved };
	if (resolved && typeof resolved === "object") {
		const def = resolved;
		return {
			definition: def,
			register: def.register ?? def.activate
		};
	}
	return {};
}
function kindIncludes(kind, target) {
	return kind === target || Array.isArray(kind) && kind.includes(target);
}
function formatBundledChannelWrongLoaderError(kind) {
	if (kindIncludes(kind, "bundled-channel-setup-entry")) return "bundled channel setup entry requires setup-runtime loader";
	if (kindIncludes(kind, "bundled-channel-entry")) return "bundled channel entry requires setup-runtime loader";
	return null;
}
function pushDiagnostics(diagnostics, append) {
	diagnostics.push(...append);
}
function maybeThrowOnPluginLoadError(registry, throwOnLoadError) {
	if (!throwOnLoadError) return;
	if (!registry.plugins.some((entry) => entry.status === "error")) return;
	throw new PluginLoadFailureError(registry);
}
function activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir) {
	const preserveGatewayHookRunner = runtimeSubagentMode === "default" && getActivePluginRuntimeSubagentMode() === "gateway-bindable" && getGlobalHookRunner() !== null;
	setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
	if (!preserveGatewayHookRunner) initializeGlobalHookRunner(registry);
}
function loadOpenClawPlugins(options = {}) {
	const requestedOnlyPluginIdSet = createPluginIdScopeSet(normalizePluginIdScope(options.onlyPluginIds));
	if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
		const emptyRegistry = createEmptyPluginRegistry();
		if (options.activate !== false) {
			clearActivatedPluginRuntimeState();
			activatePluginRegistry(emptyRegistry, `empty-plugin-scope::${resolveRuntimeSubagentMode(options.runtimeOptions)}::${options.workspaceDir ?? ""}`, resolveRuntimeSubagentMode(options.runtimeOptions), options.workspaceDir);
		}
		return emptyRegistry;
	}
	const { env, cfg, normalized, activationSource, autoEnabledReasons, onlyPluginIds, includeSetupOnlyChannelPlugins, forceSetupOnlyChannelPlugins, requireSetupEntryForSetupOnlyChannelPlugins, preferSetupRuntimeForChannelPlugins, preferBuiltPluginArtifacts, shouldActivate, shouldLoadModules, cacheKey, runtimeSubagentMode, installRecords } = resolvePluginLoadCacheContext(options);
	const logger = options.logger ?? defaultLogger();
	const validateOnly = options.mode === "validate";
	const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
	const cacheEnabled = options.cache !== false;
	if (cacheEnabled) {
		const cached = getReusableCachedPluginRegistry({
			cacheKey,
			onlyPluginIds,
			runtimeSubagentMode,
			options
		});
		if (cached) {
			if (shouldActivate) {
				restoreRegisteredAgentHarnesses(cached.state.agentHarnesses);
				restorePluginCommands(cached.state.commands ?? []);
				restoreRegisteredCompactionProviders(cached.state.compactionProviders);
				restoreDetachedTaskLifecycleRuntimeRegistration(cached.state.detachedTaskRuntimeRegistration);
				restorePluginInteractiveHandlers(cached.state.interactiveHandlers ?? []);
				restoreRegisteredEmbeddingProviders(cached.state.embeddingProviders);
				restoreRegisteredMemoryEmbeddingProviders(cached.state.memoryEmbeddingProviders);
				restoreMemoryPluginState({
					capability: cached.state.memoryCapability,
					corpusSupplements: cached.state.memoryCorpusSupplements,
					promptSupplements: cached.state.memoryPromptSupplements
				});
				activatePluginRegistry(cached.state.registry, cached.cacheKey, cached.runtimeSubagentMode, options.workspaceDir);
			}
			return cached.state.registry;
		}
	}
	pluginLoaderCacheState.beginLoad(cacheKey);
	try {
		if (shouldActivate) clearActivatedPluginRuntimeState();
		const loadPluginModule = createPluginModuleLoader(options);
		let createPluginRuntimeFactory = null;
		const resolveCreatePluginRuntime = () => {
			if (createPluginRuntimeFactory) return createPluginRuntimeFactory;
			const runtimeModulePath = resolvePluginRuntimeModulePath({ pluginSdkResolution: options.pluginSdkResolution });
			if (!runtimeModulePath) throw new Error("Unable to resolve plugin runtime module");
			const runtimeModule = withProfile({ source: runtimeModulePath }, "runtime-module", () => loadPluginModule(runtimeModulePath));
			if (typeof runtimeModule.createPluginRuntime !== "function") throw new Error("Plugin runtime module missing createPluginRuntime export");
			createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
			return createPluginRuntimeFactory;
		};
		let resolvedRuntime = null;
		const resolveRuntime = () => {
			resolvedRuntime ??= resolveCreatePluginRuntime()(options.runtimeOptions);
			return resolvedRuntime;
		};
		const lazyRuntimeReflectionKeySet = new Set(LAZY_RUNTIME_REFLECTION_KEYS);
		const resolveLazyRuntimeDescriptor = (prop) => {
			if (!lazyRuntimeReflectionKeySet.has(prop)) return Reflect.getOwnPropertyDescriptor(resolveRuntime(), prop);
			return {
				configurable: true,
				enumerable: true,
				get() {
					return Reflect.get(resolveRuntime(), prop);
				},
				set(value) {
					Reflect.set(resolveRuntime(), prop, value);
				}
			};
		};
		const { registry, createApi, rollbackPluginGlobalSideEffects, registerReload, registerNodeHostCommand, registerSecurityAuditCollector } = createPluginRegistry({
			logger,
			runtime: new Proxy({}, {
				get(_target, prop, receiver) {
					return Reflect.get(resolveRuntime(), prop, receiver);
				},
				set(_target, prop, value, receiver) {
					return Reflect.set(resolveRuntime(), prop, value, receiver);
				},
				has(_target, prop) {
					return lazyRuntimeReflectionKeySet.has(prop) || Reflect.has(resolveRuntime(), prop);
				},
				ownKeys() {
					return [...LAZY_RUNTIME_REFLECTION_KEYS];
				},
				getOwnPropertyDescriptor(_target, prop) {
					return resolveLazyRuntimeDescriptor(prop);
				},
				defineProperty(_target, prop, attributes) {
					return Reflect.defineProperty(resolveRuntime(), prop, attributes);
				},
				deleteProperty(_target, prop) {
					return Reflect.deleteProperty(resolveRuntime(), prop);
				},
				getPrototypeOf() {
					return Reflect.getPrototypeOf(resolveRuntime());
				}
			}),
			coreGatewayHandlers: options.coreGatewayHandlers,
			...options.coreGatewayMethodNames !== void 0 && { coreGatewayMethodNames: options.coreGatewayMethodNames },
			...options.hostServices !== void 0 && { hostServices: options.hostServices },
			activateGlobalSideEffects: shouldActivate
		});
		const suppliedManifestRegistry = options.manifestRegistry;
		const discovery = suppliedManifestRegistry ? {
			candidates: createPluginCandidatesFromManifestRegistry(suppliedManifestRegistry),
			diagnostics: []
		} : options.discovery ?? discoverOpenClawPlugins({
			workspaceDir: options.workspaceDir,
			extraPaths: normalized.loadPaths,
			env,
			installRecords
		});
		const manifestRegistry = suppliedManifestRegistry ?? loadPluginManifestRegistry({
			config: cfg,
			workspaceDir: options.workspaceDir,
			env,
			candidates: discovery.candidates,
			diagnostics: discovery.diagnostics,
			installRecords: Object.keys(installRecords).length > 0 ? installRecords : void 0
		});
		pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
		warnWhenAllowlistIsOpen({
			emitWarning: shouldActivate,
			logger,
			pluginsEnabled: normalized.enabled,
			allow: normalized.allow,
			warningCacheKey: cacheKey,
			warningCache: pluginLoaderCacheState,
			discoverablePlugins: manifestRegistry.plugins.filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)).map((plugin) => ({
				id: plugin.id,
				source: plugin.source,
				origin: plugin.origin
			}))
		});
		const provenance = buildProvenanceIndex({
			normalizedLoadPaths: normalized.loadPaths,
			env,
			installRecords
		});
		const manifestByRoot = new Map(manifestRegistry.plugins.map((record) => [record.rootDir, record]));
		const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
			return compareDuplicateCandidateOrder({
				left,
				right,
				manifestByRoot,
				provenance,
				env
			});
		});
		const seenIds = /* @__PURE__ */ new Map();
		const memorySlot = normalized.slots.memory;
		let selectedMemoryPluginId = null;
		let memorySlotMatched = false;
		const dreamingEngineId = resolveDreamingSidecarEngineId({
			cfg,
			memorySlot
		});
		const pluginLoadStartMs = performance.now();
		let pluginLoadAttemptCount = 0;
		for (const candidate of orderedCandidates) {
			const manifestRecord = manifestByRoot.get(candidate.rootDir);
			if (!manifestRecord) continue;
			const pluginId = manifestRecord.id;
			if (!matchesScopedPluginRequest({
				onlyPluginIdSet,
				pluginId
			})) continue;
			const activationState = resolveEffectivePluginActivationState({
				id: pluginId,
				origin: candidate.origin,
				config: normalized,
				rootConfig: cfg,
				enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
				activationSource,
				autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId])
			});
			const existingOrigin = seenIds.get(pluginId);
			if (existingOrigin) {
				const record = createPluginRecord({
					id: pluginId,
					name: manifestRecord.name ?? pluginId,
					description: manifestRecord.description,
					version: manifestRecord.version,
					packageName: manifestRecord.packageName,
					format: manifestRecord.format,
					bundleFormat: manifestRecord.bundleFormat,
					bundleCapabilities: manifestRecord.bundleCapabilities,
					source: candidate.source,
					rootDir: candidate.rootDir,
					origin: candidate.origin,
					workspaceDir: candidate.workspaceDir,
					trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
					enabled: false,
					compat: collectPluginManifestCompatCodes(manifestRecord),
					activationState,
					syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
					channelIds: manifestRecord.channels,
					providerIds: manifestRecord.providers,
					configSchema: Boolean(manifestRecord.configSchema),
					contracts: manifestRecord.contracts
				});
				record.status = "disabled";
				record.error = `overridden by ${existingOrigin} plugin`;
				markPluginActivationDisabled(record, record.error);
				registry.plugins.push(record);
				continue;
			}
			const enableState = resolveEffectiveEnableState({
				id: pluginId,
				origin: candidate.origin,
				config: normalized,
				rootConfig: cfg,
				enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
				activationSource
			});
			const entry = normalized.entries[pluginId];
			const record = createPluginRecord({
				id: pluginId,
				name: manifestRecord.name ?? pluginId,
				description: manifestRecord.description,
				version: manifestRecord.version,
				packageName: manifestRecord.packageName,
				format: manifestRecord.format,
				bundleFormat: manifestRecord.bundleFormat,
				bundleCapabilities: manifestRecord.bundleCapabilities,
				source: candidate.source,
				rootDir: candidate.rootDir,
				origin: candidate.origin,
				workspaceDir: candidate.workspaceDir,
				trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
				enabled: enableState.enabled,
				compat: collectPluginManifestCompatCodes(manifestRecord),
				activationState,
				syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
				channelIds: manifestRecord.channels,
				providerIds: manifestRecord.providers,
				configSchema: Boolean(manifestRecord.configSchema),
				contracts: manifestRecord.contracts
			});
			record.kind = manifestRecord.kind;
			record.configUiHints = manifestRecord.configUiHints;
			record.configJsonSchema = manifestRecord.configSchema;
			const pushPluginLoadError = (message) => {
				record.status = "error";
				record.error = message;
				record.failedAt = /* @__PURE__ */ new Date();
				record.failurePhase = "validation";
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
				registry.diagnostics.push({
					level: "error",
					pluginId: record.id,
					source: record.source,
					message: record.error
				});
			};
			const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
			const runtimeCandidateEntry = resolvePreferredBuiltBundledRuntimeArtifact({
				source: candidate.source,
				rootDir: pluginRoot,
				origin: candidate.origin,
				preferBuiltPluginArtifacts
			});
			const runtimeSetupEntry = manifestRecord.setupSource ? resolvePreferredBuiltBundledRuntimeArtifact({
				source: manifestRecord.setupSource,
				rootDir: pluginRoot,
				origin: candidate.origin,
				preferBuiltPluginArtifacts
			}) : void 0;
			const scopedSetupOnlyChannelPluginRequested = includeSetupOnlyChannelPlugins && !validateOnly && Boolean(onlyPluginIdSet) && manifestRecord.channels.length > 0 && (!enableState.enabled || forceSetupOnlyChannelPlugins);
			const registrationPlan = resolvePluginRegistrationPlan({
				canLoadScopedSetupOnlyChannelPlugin: scopedSetupOnlyChannelPluginRequested && (!requireSetupEntryForSetupOnlyChannelPlugins || Boolean(manifestRecord.setupSource)),
				scopedSetupOnlyChannelPluginRequested,
				requireSetupEntryForSetupOnlyChannelPlugins,
				enableStateEnabled: enableState.enabled,
				shouldLoadModules,
				validateOnly,
				shouldActivate,
				manifestRecord,
				cfg,
				env,
				preferSetupRuntimeForChannelPlugins,
				toolDiscovery: options.toolDiscovery === true
			});
			if (!registrationPlan) {
				record.status = "disabled";
				record.error = enableState.reason;
				markPluginActivationDisabled(record, enableState.reason);
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
				continue;
			}
			const registrationMode = registrationPlan.mode;
			if (!enableState.enabled) {
				record.status = "disabled";
				record.error = enableState.reason;
				markPluginActivationDisabled(record, enableState.reason);
			}
			if (record.format === "bundle") {
				const unsupportedCapabilities = (record.bundleCapabilities ?? []).filter((capability) => capability !== "skills" && capability !== "mcpServers" && capability !== "settings" && !((capability === "commands" || capability === "agents" || capability === "outputStyles" || capability === "lspServers") && (record.bundleFormat === "claude" || record.bundleFormat === "cursor")) && !(capability === "hooks" && (record.bundleFormat === "codex" || record.bundleFormat === "claude")));
				for (const capability of unsupportedCapabilities) registry.diagnostics.push({
					level: "warn",
					pluginId: record.id,
					source: record.source,
					message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`
				});
				if (enableState.enabled && record.rootDir && record.bundleFormat && (record.bundleCapabilities ?? []).includes("mcpServers")) {
					const runtimeSupport = inspectBundleMcpRuntimeSupport({
						pluginId: record.id,
						rootDir: record.rootDir,
						bundleFormat: record.bundleFormat
					});
					for (const message of runtimeSupport.diagnostics) registry.diagnostics.push({
						level: "warn",
						pluginId: record.id,
						source: record.source,
						message
					});
					if (runtimeSupport.unsupportedServerNames.length > 0) registry.diagnostics.push({
						level: "warn",
						pluginId: record.id,
						source: record.source,
						message: `bundle MCP servers use unsupported transports or incomplete configs (stdio only today): ${runtimeSupport.unsupportedServerNames.join(", ")}`
					});
				}
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
				continue;
			}
			if (registrationPlan.runRuntimeCapabilityPolicy && candidate.origin === "bundled" && hasKind(manifestRecord.kind, "memory")) {
				if (pluginId !== dreamingEngineId) {
					const earlyMemoryDecision = resolveMemorySlotDecision({
						id: record.id,
						kind: manifestRecord.kind,
						slot: memorySlot,
						selectedId: selectedMemoryPluginId
					});
					if (!earlyMemoryDecision.enabled) {
						record.enabled = false;
						record.status = "disabled";
						record.error = earlyMemoryDecision.reason;
						markPluginActivationDisabled(record, earlyMemoryDecision.reason);
						registry.plugins.push(record);
						seenIds.set(pluginId, candidate.origin);
						continue;
					}
				}
			}
			if (!manifestRecord.configSchema) {
				pushPluginLoadError("missing config schema");
				continue;
			}
			if (!shouldLoadModules && registrationPlan.runRuntimeCapabilityPolicy) {
				const memoryDecision = resolveMemorySlotDecision({
					id: record.id,
					kind: record.kind,
					slot: memorySlot,
					selectedId: selectedMemoryPluginId
				});
				if (!memoryDecision.enabled && pluginId !== dreamingEngineId) {
					record.enabled = false;
					record.status = "disabled";
					record.error = memoryDecision.reason;
					markPluginActivationDisabled(record, memoryDecision.reason);
					registry.plugins.push(record);
					seenIds.set(pluginId, candidate.origin);
					continue;
				}
				if (memoryDecision.selected && hasKind(record.kind, "memory")) {
					selectedMemoryPluginId = record.id;
					memorySlotMatched = true;
					record.memorySlotSelected = true;
				}
			}
			const validatedConfig = validatePluginConfig({
				schema: manifestRecord.configSchema,
				cacheKey: manifestRecord.schemaCacheKey,
				value: entry?.config
			});
			if (!validatedConfig.ok) {
				logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
				pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
				continue;
			}
			if (!shouldLoadModules) {
				applyManifestSnapshotMetadata(record, manifestRecord);
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
				continue;
			}
			const loadEntry = registrationPlan.loadSetupEntry && runtimeSetupEntry ? runtimeSetupEntry : runtimeCandidateEntry;
			const moduleLoadSource = resolveCanonicalDistRuntimeSource(loadEntry.source);
			const moduleRoot = resolveCanonicalDistRuntimeSource(loadEntry.rootDir);
			const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
				origin: candidate.origin,
				rootDir: candidate.rootDir,
				env
			});
			const opened = openRootFileSync({
				absolutePath: moduleLoadSource,
				rootPath: moduleRoot,
				boundaryLabel: "plugin root",
				rejectHardlinks,
				skipLexicalRootCheck: true
			});
			if (!opened.ok) {
				pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
				continue;
			}
			const safeSource = opened.path;
			fs.closeSync(opened.fd);
			let mod = null;
			let moduleLoadMs = 0;
			let moduleLoadFailed = false;
			const beforeModuleLoad = performance.now();
			try {
				recordImportedPluginId(record.id);
				pluginLoadAttemptCount++;
				logger.debug?.(`[plugins] loading ${record.id} from ${safeSource}`);
				mod = withProfile({
					pluginId: record.id,
					source: safeSource
				}, registrationMode, () => loadPluginModule(safeSource));
			} catch (err) {
				recordPluginError({
					logger,
					registry,
					record,
					seenIds,
					pluginId,
					origin: candidate.origin,
					phase: "load",
					error: err,
					logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
					diagnosticMessagePrefix: "failed to load plugin: "
				});
				moduleLoadFailed = true;
				continue;
			} finally {
				moduleLoadMs = performance.now() - beforeModuleLoad;
				detailPluginStartupTrace(options.startupTrace, record.id, [["loadMs", moduleLoadMs], ["loadFailedCount", moduleLoadFailed ? 1 : 0]]);
			}
			if (registrationPlan.loadSetupEntry && manifestRecord.setupSource) {
				const setupRegistration = resolveSetupChannelRegistration(mod);
				if (setupRegistration.loadError) {
					recordPluginError({
						logger,
						registry,
						record,
						seenIds,
						pluginId,
						origin: candidate.origin,
						phase: "load",
						error: setupRegistration.loadError,
						logPrefix: `[plugins] ${record.id} failed to load setup entry from ${record.source}: `,
						diagnosticMessagePrefix: "failed to load setup entry: "
					});
					continue;
				}
				if (setupRegistration.plugin) {
					if (!channelPluginIdBelongsToManifest({
						channelId: setupRegistration.plugin.id,
						pluginId: record.id,
						manifestChannels: manifestRecord.channels
					})) {
						pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", setup export uses "${setupRegistration.plugin.id}")`);
						continue;
					}
					const api = createApi(record, {
						config: cfg,
						pluginConfig: {},
						hookPolicy: entry?.hooks,
						registrationMode
					});
					let mergedSetupRegistration = setupRegistration;
					let runtimeSetterApplied = false;
					if (registrationPlan.loadSetupRuntimeEntry && setupRegistration.usesBundledSetupContract && resolveCanonicalDistRuntimeSource(runtimeCandidateEntry.source) !== safeSource) {
						const runtimeOpened = openRootFileSync({
							absolutePath: resolveCanonicalDistRuntimeSource(runtimeCandidateEntry.source),
							rootPath: resolveCanonicalDistRuntimeSource(runtimeCandidateEntry.rootDir),
							boundaryLabel: "plugin root",
							rejectHardlinks,
							skipLexicalRootCheck: true
						});
						if (!runtimeOpened.ok) {
							pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
							continue;
						}
						const safeRuntimeSource = runtimeOpened.path;
						fs.closeSync(runtimeOpened.fd);
						let runtimeMod = null;
						try {
							runtimeMod = withProfile({
								pluginId: record.id,
								source: safeRuntimeSource
							}, "load-setup-runtime-entry", () => loadPluginModule(safeRuntimeSource));
						} catch (err) {
							recordPluginError({
								logger,
								registry,
								record,
								seenIds,
								pluginId,
								origin: candidate.origin,
								phase: "load",
								error: err,
								logPrefix: `[plugins] ${record.id} failed to load setup-runtime entry from ${record.source}: `,
								diagnosticMessagePrefix: "failed to load setup-runtime entry: "
							});
							continue;
						}
						const runtimeRegistration = resolveBundledRuntimeChannelRegistration(runtimeMod);
						if (runtimeRegistration.id && runtimeRegistration.id !== record.id) {
							pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", runtime entry uses "${runtimeRegistration.id}")`);
							continue;
						}
						if (runtimeRegistration.setChannelRuntime) try {
							runtimeRegistration.setChannelRuntime(api.runtime);
							runtimeSetterApplied = true;
						} catch (err) {
							recordPluginError({
								logger,
								registry,
								record,
								seenIds,
								pluginId,
								origin: candidate.origin,
								phase: "load",
								error: err,
								logPrefix: `[plugins] ${record.id} failed to apply setup-runtime channel runtime from ${record.source}: `,
								diagnosticMessagePrefix: "failed to apply setup-runtime channel runtime: "
							});
							continue;
						}
						const runtimePluginRegistration = loadBundledRuntimeChannelPlugin({ registration: runtimeRegistration });
						if (runtimePluginRegistration.loadError) {
							recordPluginError({
								logger,
								registry,
								record,
								seenIds,
								pluginId,
								origin: candidate.origin,
								phase: "load",
								error: runtimePluginRegistration.loadError,
								logPrefix: `[plugins] ${record.id} failed to load setup-runtime channel entry from ${record.source}: `,
								diagnosticMessagePrefix: "failed to load setup-runtime channel entry: "
							});
							continue;
						}
						if (runtimePluginRegistration.plugin) {
							if (runtimePluginRegistration.plugin.id && runtimePluginRegistration.plugin.id !== record.id) {
								pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", runtime export uses "${runtimePluginRegistration.plugin.id}")`);
								continue;
							}
							mergedSetupRegistration = {
								...setupRegistration,
								plugin: mergeSetupRuntimeChannelPlugin(runtimePluginRegistration.plugin, setupRegistration.plugin),
								setChannelRuntime: runtimeRegistration.setChannelRuntime ?? setupRegistration.setChannelRuntime
							};
						}
					}
					const mergedSetupPlugin = mergedSetupRegistration.plugin;
					if (!mergedSetupPlugin) continue;
					if (!channelPluginIdBelongsToManifest({
						channelId: mergedSetupPlugin.id,
						pluginId: record.id,
						manifestChannels: manifestRecord.channels
					})) {
						pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", setup export uses "${mergedSetupPlugin.id}")`);
						continue;
					}
					if (!runtimeSetterApplied) try {
						mergedSetupRegistration.setChannelRuntime?.(api.runtime);
					} catch (err) {
						recordPluginError({
							logger,
							registry,
							record,
							seenIds,
							pluginId,
							origin: candidate.origin,
							phase: "load",
							error: err,
							logPrefix: `[plugins] ${record.id} failed to apply setup channel runtime from ${record.source}: `,
							diagnosticMessagePrefix: "failed to apply setup channel runtime: "
						});
						continue;
					}
					api.registerChannel(mergedSetupPlugin);
					registry.plugins.push(record);
					seenIds.set(pluginId, candidate.origin);
					continue;
				}
			}
			const resolved = resolvePluginModuleExport(mod);
			const definition = resolved.definition;
			const register = resolved.register;
			if (definition?.id && definition.id !== record.id) {
				pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`);
				continue;
			}
			record.name = definition?.name ?? record.name;
			record.description = definition?.description ?? record.description;
			record.version = definition?.version ?? record.version;
			const manifestKind = record.kind;
			const exportKind = definition?.kind;
			if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) registry.diagnostics.push({
				level: "warn",
				pluginId: record.id,
				source: record.source,
				message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`
			});
			record.kind = definition?.kind ?? record.kind;
			if (hasKind(record.kind, "memory") && memorySlot === record.id) memorySlotMatched = true;
			if (registrationPlan.runRuntimeCapabilityPolicy) {
				if (pluginId !== dreamingEngineId) {
					const memoryDecision = resolveMemorySlotDecision({
						id: record.id,
						kind: record.kind,
						slot: memorySlot,
						selectedId: selectedMemoryPluginId
					});
					if (!memoryDecision.enabled) {
						record.enabled = false;
						record.status = "disabled";
						record.error = memoryDecision.reason;
						markPluginActivationDisabled(record, memoryDecision.reason);
						registry.plugins.push(record);
						seenIds.set(pluginId, candidate.origin);
						continue;
					}
					if (memoryDecision.selected && hasKind(record.kind, "memory")) {
						selectedMemoryPluginId = record.id;
						record.memorySlotSelected = true;
					}
				}
			}
			if (registrationPlan.runFullActivationOnlyRegistrations) {
				if (definition?.reload) registerReload(record, definition.reload);
				for (const nodeHostCommand of definition?.nodeHostCommands ?? []) registerNodeHostCommand(record, nodeHostCommand);
				for (const collector of definition?.securityAuditCollectors ?? []) registerSecurityAuditCollector(record, collector);
			}
			if (validateOnly) {
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
				continue;
			}
			if (typeof register !== "function") {
				const bundledChannelWrongLoaderError = formatBundledChannelWrongLoaderError(record.kind);
				if (bundledChannelWrongLoaderError) {
					logger.error(`[plugins] ${record.id} ${bundledChannelWrongLoaderError}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`);
					pushPluginLoadError(bundledChannelWrongLoaderError);
				} else {
					logger.error(`[plugins] ${record.id} missing register/activate export`);
					pushPluginLoadError(formatMissingPluginRegisterError(mod, env));
				}
				continue;
			}
			const api = createApi(record, {
				config: cfg,
				pluginConfig: validatedConfig.value,
				hookPolicy: entry?.hooks,
				registrationMode
			});
			const registrySnapshot = snapshotPluginRegistry(registry);
			const previousAgentHarnesses = listRegisteredAgentHarnesses();
			const previousCompactionProviders = listRegisteredCompactionProviders();
			const previousDetachedTaskRuntimeRegistration = getDetachedTaskLifecycleRuntimeRegistration();
			const previousEmbeddingProviders = listRegisteredEmbeddingProviders();
			const previousMemoryCapability = getMemoryCapabilityRegistration();
			const previousMemoryEmbeddingProviders = listRegisteredMemoryEmbeddingProviders();
			const previousMemoryCorpusSupplements = listMemoryCorpusSupplements();
			const previousMemoryPromptSupplements = listMemoryPromptSupplements();
			const beforeRegister = performance.now();
			let registerFailed = false;
			try {
				withProfile({
					pluginId: record.id,
					source: record.source
				}, `${registrationMode}:register`, () => runPluginRegisterSync(register, api));
				if (!shouldActivate) {
					restoreRegisteredAgentHarnesses(previousAgentHarnesses);
					restoreRegisteredCompactionProviders(previousCompactionProviders);
					restoreDetachedTaskLifecycleRuntimeRegistration(previousDetachedTaskRuntimeRegistration);
					restoreRegisteredEmbeddingProviders(previousEmbeddingProviders);
					restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
					restoreMemoryPluginState({
						capability: previousMemoryCapability,
						corpusSupplements: previousMemoryCorpusSupplements,
						promptSupplements: previousMemoryPromptSupplements
					});
				}
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
			} catch (err) {
				rollbackPluginGlobalSideEffects(record.id);
				restorePluginRegistry(registry, registrySnapshot);
				restoreRegisteredAgentHarnesses(previousAgentHarnesses);
				restoreRegisteredCompactionProviders(previousCompactionProviders);
				restoreDetachedTaskLifecycleRuntimeRegistration(previousDetachedTaskRuntimeRegistration);
				restoreRegisteredEmbeddingProviders(previousEmbeddingProviders);
				restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
				restoreMemoryPluginState({
					capability: previousMemoryCapability,
					corpusSupplements: previousMemoryCorpusSupplements,
					promptSupplements: previousMemoryPromptSupplements
				});
				recordPluginError({
					logger,
					registry,
					record,
					seenIds,
					pluginId,
					origin: candidate.origin,
					phase: "register",
					error: err,
					logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
					diagnosticMessagePrefix: "plugin failed during register: "
				});
				registerFailed = true;
			} finally {
				const registerMs = performance.now() - beforeRegister;
				detailPluginStartupTrace(options.startupTrace, record.id, [
					["registerMs", registerMs],
					["loadAndRegisterMs", moduleLoadMs + registerMs],
					["registerFailedCount", registerFailed ? 1 : 0]
				]);
			}
		}
		const pluginLoadElapsedMs = performance.now() - pluginLoadStartMs;
		if (pluginLoadAttemptCount > 0) logger.debug?.(`[plugins] loaded ${registry.plugins.length} plugin(s) (${pluginLoadAttemptCount} attempted) in ${pluginLoadElapsedMs.toFixed(1)}ms`);
		if (!onlyPluginIdSet && typeof memorySlot === "string" && !memorySlotMatched) registry.diagnostics.push({
			level: "warn",
			message: `memory slot plugin not found or not marked as memory: ${memorySlot}`
		});
		warnAboutUntrackedLoadedPlugins({
			registry,
			provenance,
			allowlist: normalized.allow,
			emitWarning: shouldActivate,
			logger,
			env
		});
		maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);
		if (shouldActivate && options.mode !== "validate") {
			const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
			if (failedPlugins.length > 0) logger.warn(`[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(failedPlugins)}). Run 'openclaw plugins list' for details.`);
		}
		if (cacheEnabled) setCachedPluginRegistry(cacheKey, {
			commands: listRegisteredPluginCommands(),
			detachedTaskRuntimeRegistration: getDetachedTaskLifecycleRuntimeRegistration(),
			interactiveHandlers: listPluginInteractiveHandlers(),
			memoryCapability: getMemoryCapabilityRegistration(),
			memoryCorpusSupplements: listMemoryCorpusSupplements(),
			registry,
			agentHarnesses: listRegisteredAgentHarnesses(),
			compactionProviders: listRegisteredCompactionProviders(),
			embeddingProviders: listRegisteredEmbeddingProviders(),
			memoryEmbeddingProviders: listRegisteredMemoryEmbeddingProviders(),
			memoryPromptSupplements: listMemoryPromptSupplements()
		}, onlyPluginIds);
		if (shouldActivate) activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
		return registry;
	} finally {
		pluginLoaderCacheState.finishLoad(cacheKey);
	}
}
async function loadOpenClawPluginCliRegistry(options = {}) {
	const { env, cfg, normalized, activationSource, autoEnabledReasons, onlyPluginIds, cacheKey, installRecords } = resolvePluginLoadCacheContext({
		...options,
		activate: false
	});
	const logger = options.logger ?? defaultLogger();
	const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
	const loadPluginModule = createPluginModuleLoader(options);
	const { registry, registerCli } = createPluginRegistry({
		logger,
		runtime: {},
		coreGatewayHandlers: options.coreGatewayHandlers,
		...options.coreGatewayMethodNames !== void 0 && { coreGatewayMethodNames: options.coreGatewayMethodNames },
		activateGlobalSideEffects: false
	});
	const discovery = options.discovery ?? discoverOpenClawPlugins({
		workspaceDir: options.workspaceDir,
		extraPaths: normalized.loadPaths,
		env,
		installRecords
	});
	const manifestRegistry = loadPluginManifestRegistry({
		config: cfg,
		workspaceDir: options.workspaceDir,
		env,
		candidates: discovery.candidates,
		diagnostics: discovery.diagnostics,
		installRecords: Object.keys(installRecords).length > 0 ? installRecords : void 0
	});
	pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
	warnWhenAllowlistIsOpen({
		emitWarning: false,
		logger,
		pluginsEnabled: normalized.enabled,
		allow: normalized.allow,
		warningCacheKey: `${cacheKey}::cli-metadata`,
		warningCache: pluginLoaderCacheState,
		discoverablePlugins: manifestRegistry.plugins.filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)).map((plugin) => ({
			id: plugin.id,
			source: plugin.source,
			origin: plugin.origin
		}))
	});
	const provenance = buildProvenanceIndex({
		normalizedLoadPaths: normalized.loadPaths,
		env,
		installRecords
	});
	const manifestByRoot = new Map(manifestRegistry.plugins.map((record) => [record.rootDir, record]));
	const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
		return compareDuplicateCandidateOrder({
			left,
			right,
			manifestByRoot,
			provenance,
			env
		});
	});
	const seenIds = /* @__PURE__ */ new Map();
	const memorySlot = normalized.slots.memory;
	let selectedMemoryPluginId = null;
	const dreamingEngineId = resolveDreamingSidecarEngineId({
		cfg,
		memorySlot
	});
	for (const candidate of orderedCandidates) {
		const manifestRecord = manifestByRoot.get(candidate.rootDir);
		if (!manifestRecord) continue;
		const pluginId = manifestRecord.id;
		if (!matchesScopedPluginRequest({
			onlyPluginIdSet,
			pluginId
		})) continue;
		const activationState = resolveEffectivePluginActivationState({
			id: pluginId,
			origin: candidate.origin,
			config: normalized,
			rootConfig: cfg,
			enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
			activationSource,
			autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId])
		});
		const existingOrigin = seenIds.get(pluginId);
		if (existingOrigin) {
			const record = createPluginRecord({
				id: pluginId,
				name: manifestRecord.name ?? pluginId,
				description: manifestRecord.description,
				version: manifestRecord.version,
				packageName: manifestRecord.packageName,
				format: manifestRecord.format,
				bundleFormat: manifestRecord.bundleFormat,
				bundleCapabilities: manifestRecord.bundleCapabilities,
				source: candidate.source,
				rootDir: candidate.rootDir,
				origin: candidate.origin,
				workspaceDir: candidate.workspaceDir,
				trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
				enabled: false,
				compat: collectPluginManifestCompatCodes(manifestRecord),
				activationState,
				syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
				channelIds: manifestRecord.channels,
				providerIds: manifestRecord.providers,
				configSchema: Boolean(manifestRecord.configSchema),
				contracts: manifestRecord.contracts
			});
			record.status = "disabled";
			record.error = `overridden by ${existingOrigin} plugin`;
			markPluginActivationDisabled(record, record.error);
			registry.plugins.push(record);
			continue;
		}
		const enableState = resolveEffectiveEnableState({
			id: pluginId,
			origin: candidate.origin,
			config: normalized,
			rootConfig: cfg,
			enabledByDefault: isPluginEnabledByDefaultForPlatform(manifestRecord),
			activationSource
		});
		const entry = normalized.entries[pluginId];
		const record = createPluginRecord({
			id: pluginId,
			name: manifestRecord.name ?? pluginId,
			description: manifestRecord.description,
			version: manifestRecord.version,
			packageName: manifestRecord.packageName,
			format: manifestRecord.format,
			bundleFormat: manifestRecord.bundleFormat,
			bundleCapabilities: manifestRecord.bundleCapabilities,
			source: candidate.source,
			rootDir: candidate.rootDir,
			origin: candidate.origin,
			workspaceDir: candidate.workspaceDir,
			trustedOfficialInstall: manifestRecord.trustedOfficialInstall,
			enabled: enableState.enabled,
			compat: collectPluginManifestCompatCodes(manifestRecord),
			activationState,
			syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
			channelIds: manifestRecord.channels,
			providerIds: manifestRecord.providers,
			configSchema: Boolean(manifestRecord.configSchema),
			contracts: manifestRecord.contracts
		});
		record.kind = manifestRecord.kind;
		record.configUiHints = manifestRecord.configUiHints;
		record.configJsonSchema = manifestRecord.configSchema;
		const pushPluginLoadError = (message) => {
			record.status = "error";
			record.error = message;
			record.failedAt = /* @__PURE__ */ new Date();
			record.failurePhase = "validation";
			registry.plugins.push(record);
			seenIds.set(pluginId, candidate.origin);
			registry.diagnostics.push({
				level: "error",
				pluginId: record.id,
				source: record.source,
				message: record.error
			});
		};
		if (!enableState.enabled) {
			record.status = "disabled";
			record.error = enableState.reason;
			markPluginActivationDisabled(record, enableState.reason);
			registry.plugins.push(record);
			seenIds.set(pluginId, candidate.origin);
			continue;
		}
		if (record.format === "bundle") {
			registry.plugins.push(record);
			seenIds.set(pluginId, candidate.origin);
			continue;
		}
		if (!manifestRecord.configSchema) {
			pushPluginLoadError("missing config schema");
			continue;
		}
		const validatedConfig = validatePluginConfig({
			schema: manifestRecord.configSchema,
			cacheKey: manifestRecord.schemaCacheKey,
			value: entry?.config
		});
		if (!validatedConfig.ok) {
			logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
			pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
			continue;
		}
		const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
		const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);
		const sourceForCliMetadata = candidate.origin === "bundled" ? cliMetadataSource ? safeRealpathOrResolve(cliMetadataSource) : null : cliMetadataSource ?? candidate.source;
		if (!sourceForCliMetadata) {
			record.status = "loaded";
			registry.plugins.push(record);
			seenIds.set(pluginId, candidate.origin);
			continue;
		}
		const opened = openRootFileSync({
			absolutePath: sourceForCliMetadata,
			rootPath: pluginRoot,
			boundaryLabel: "plugin root",
			rejectHardlinks: shouldRejectHardlinkedPluginFiles({
				origin: candidate.origin,
				rootDir: candidate.rootDir,
				env
			}),
			skipLexicalRootCheck: true
		});
		if (!opened.ok) {
			pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
			continue;
		}
		const safeSource = opened.path;
		fs.closeSync(opened.fd);
		let mod = null;
		try {
			mod = withProfile({
				pluginId: record.id,
				source: safeSource
			}, "cli-metadata", () => loadPluginModule(safeSource));
		} catch (err) {
			recordPluginError({
				logger,
				registry,
				record,
				seenIds,
				pluginId,
				origin: candidate.origin,
				phase: "load",
				error: err,
				logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
				diagnosticMessagePrefix: "failed to load plugin: "
			});
			continue;
		}
		const resolved = resolvePluginModuleExport(mod);
		const definition = resolved.definition;
		const register = resolved.register;
		if (definition?.id && definition.id !== record.id) {
			pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`);
			continue;
		}
		record.name = definition?.name ?? record.name;
		record.description = definition?.description ?? record.description;
		record.version = definition?.version ?? record.version;
		const manifestKind = record.kind;
		const exportKind = definition?.kind;
		if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) registry.diagnostics.push({
			level: "warn",
			pluginId: record.id,
			source: record.source,
			message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`
		});
		record.kind = definition?.kind ?? record.kind;
		if (pluginId !== dreamingEngineId) {
			const memoryDecision = resolveMemorySlotDecision({
				id: record.id,
				kind: record.kind,
				slot: memorySlot,
				selectedId: selectedMemoryPluginId
			});
			if (!memoryDecision.enabled) {
				record.enabled = false;
				record.status = "disabled";
				record.error = memoryDecision.reason;
				markPluginActivationDisabled(record, memoryDecision.reason);
				registry.plugins.push(record);
				seenIds.set(pluginId, candidate.origin);
				continue;
			}
			if (memoryDecision.selected && hasKind(record.kind, "memory")) {
				selectedMemoryPluginId = record.id;
				record.memorySlotSelected = true;
			}
		}
		if (typeof register !== "function") {
			const bundledChannelWrongLoaderError = formatBundledChannelWrongLoaderError(record.kind);
			if (bundledChannelWrongLoaderError) {
				logger.error(`[plugins] ${record.id} ${bundledChannelWrongLoaderError}; ensure plugin is loaded via bundled channel discovery, not legacy plugin loader`);
				pushPluginLoadError(bundledChannelWrongLoaderError);
			} else {
				logger.error(`[plugins] ${record.id} missing register/activate export`);
				pushPluginLoadError(formatMissingPluginRegisterError(mod, env));
			}
			continue;
		}
		const api = buildPluginApi({
			id: record.id,
			name: record.name,
			version: record.version,
			description: record.description,
			source: record.source,
			rootDir: record.rootDir,
			registrationMode: "cli-metadata",
			config: cfg,
			pluginConfig: validatedConfig.value,
			runtime: {},
			logger,
			resolvePath: (input) => resolveUserPath(input),
			handlers: { registerCli: (registrar, opts) => registerCli(record, registrar, opts) }
		});
		const registrySnapshot = snapshotPluginRegistry(registry);
		try {
			withProfile({
				pluginId: record.id,
				source: record.source
			}, "cli-metadata:register", () => runPluginRegisterSync(register, api));
			registry.plugins.push(record);
			seenIds.set(pluginId, candidate.origin);
		} catch (err) {
			restorePluginRegistry(registry, registrySnapshot);
			recordPluginError({
				logger,
				registry,
				record,
				seenIds,
				pluginId,
				origin: candidate.origin,
				phase: "register",
				error: err,
				logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
				diagnosticMessagePrefix: "plugin failed during register: "
			});
		}
	}
	return registry;
}
function safeRealpathOrResolve(value) {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}
function resolveCliMetadataEntrySource(rootDir) {
	for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
		const candidate = path.join(rootDir, basename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
//#endregion
export { createPluginGatewayMethodDescriptors as C, getCompactionProvider as D, listRegisteredEmbeddingProviders as E, resolvePluginActivationSourceConfig as O, createGatewayMethodRegistry as S, getRegisteredEmbeddingProvider as T, getPluginSessionExtensionStateSync as _, getRuntimePluginRegistryForLoadOptions as a, listCodexAppServerExtensionFactories as b, loadOpenClawPlugins as c, resolveRuntimePluginRegistry as d, testing as f, drainPluginNextTurnInjectionContext as g, synthesizeMediaGenerationCatalogEntries as h, clearPluginRegistryLoadCache as i, resolveCompatibleRuntimePluginRegistry as l, listMediaGenerationProviderModels as m, clearActivatedPluginRuntimeState as n, isPluginRegistryLoadInFlight as o, createPluginRegistry as p, clearPluginLoaderCache as r, loadOpenClawPluginCliRegistry as s, PluginLoadFailureError as t, resolvePluginRegistryLoadCacheKey as u, patchPluginSessionExtension as v, PluginLoadReentryError as w, createGatewayMethodDescriptorsFromHandlers as x, projectPluginSessionExtensionsSync as y };
