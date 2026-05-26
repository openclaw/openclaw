import { s as normalizePluginsConfig, t as applyTestPluginDefaults } from "./config-state-CjJBf8PG.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { h as resolveRuntimeConfigCacheKey } from "./runtime-snapshot-DgdkBEdP.js";
import { a as loadManifestContractSnapshot, n as isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility-LkT7g78Y.js";
import { t as findUndeclaredPluginToolNames } from "./tool-contracts-CbE_6nZb.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { i as resolvePluginRuntimeLoadContext, t as buildPluginRuntimeLoadOptions } from "./load-context-BO-9CJts.js";
import { n as matchesAnyGlobPattern, t as compileGlobPatterns } from "./glob-pattern-CrqljM7B.js";
import { m as normalizeToolName } from "./tool-policy-COX5DaEj.js";
import { t as hasManifestToolAvailability } from "./manifest-tool-availability-6BoazIq-.js";
import { t as ensureStandaloneRuntimePluginRegistryLoaded } from "./standalone-runtime-registry-loader-B16U68P-.js";
import fs from "node:fs";
//#region src/plugins/tool-descriptor-cache.ts
const PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION = 1;
const PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT = 256;
const descriptorCache = /* @__PURE__ */ new Map();
let descriptorCacheObjectIds = /* @__PURE__ */ new WeakMap();
let nextDescriptorCacheObjectId = 1;
function createPluginToolDescriptorConfigCacheKeyMemo() {
	return /* @__PURE__ */ new WeakMap();
}
function resetPluginToolDescriptorCache() {
	descriptorCache.clear();
	descriptorCacheObjectIds = /* @__PURE__ */ new WeakMap();
	nextDescriptorCacheObjectId = 1;
}
function sourceFingerprint(source) {
	try {
		const stat = fs.statSync(source);
		return `${stat.size}:${Math.round(stat.mtimeMs)}`;
	} catch {
		return "missing";
	}
}
function getDescriptorCacheObjectId(value) {
	if (!value) return null;
	const existing = descriptorCacheObjectIds.get(value);
	if (existing !== void 0) return existing;
	const next = nextDescriptorCacheObjectId++;
	descriptorCacheObjectIds.set(value, next);
	return next;
}
function stripDescriptorVolatileConfigFields(value) {
	if (typeof value !== "object") return value;
	if (!("meta" in value) && !("wizard" in value)) return value;
	const { meta: _meta, wizard: _wizard, ...stableConfig } = value;
	return stableConfig;
}
function getDescriptorConfigCacheKey(value, memo) {
	if (!value) return null;
	const cached = memo?.get(value);
	if (cached !== void 0) return cached;
	let resolved;
	try {
		resolved = resolveRuntimeConfigCacheKey(stripDescriptorVolatileConfigFields(value));
	} catch {
		resolved = getDescriptorCacheObjectId(value);
	}
	memo?.set(value, resolved);
	return resolved;
}
function buildDescriptorContextCacheKey(params) {
	const { ctx } = params;
	return JSON.stringify({
		config: getDescriptorConfigCacheKey(ctx.config, params.configCacheKeyMemo),
		runtimeConfig: getDescriptorConfigCacheKey(ctx.runtimeConfig, params.configCacheKeyMemo),
		currentRuntimeConfig: getDescriptorConfigCacheKey(params.currentRuntimeConfig, params.configCacheKeyMemo),
		fsPolicy: ctx.fsPolicy ?? null,
		workspaceDir: ctx.workspaceDir ?? null,
		agentDir: ctx.agentDir ?? null,
		agentId: ctx.agentId ?? null,
		activeModel: ctx.activeModel ?? null,
		browser: ctx.browser ?? null,
		messageChannel: ctx.messageChannel ?? null,
		agentAccountId: ctx.agentAccountId ?? null,
		deliveryContext: ctx.deliveryContext ?? null,
		requesterSenderId: ctx.requesterSenderId ?? null,
		sandboxed: ctx.sandboxed ?? null
	});
}
function buildPluginToolDescriptorCacheKey(params) {
	return JSON.stringify({
		version: PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION,
		pluginId: params.pluginId,
		source: params.source,
		rootDir: params.rootDir ?? null,
		sourceFingerprint: sourceFingerprint(params.source),
		contractToolNames: [...params.contractToolNames].toSorted(),
		context: buildDescriptorContextCacheKey({
			ctx: params.ctx,
			currentRuntimeConfig: params.currentRuntimeConfig,
			configCacheKeyMemo: params.configCacheKeyMemo
		})
	});
}
function asJsonObject(value) {
	return value;
}
function capturePluginToolDescriptor(params) {
	const label = params.tool.label;
	const title = typeof label === "string" && label.trim() ? label.trim() : void 0;
	return {
		...params.tool.displaySummary ? { displaySummary: params.tool.displaySummary } : {},
		optional: params.optional,
		descriptor: {
			name: params.tool.name,
			...title ? { title } : {},
			description: params.tool.description,
			inputSchema: asJsonObject(params.tool.parameters),
			owner: {
				kind: "plugin",
				pluginId: params.pluginId
			},
			executor: {
				kind: "plugin",
				pluginId: params.pluginId,
				toolName: params.tool.name
			}
		}
	};
}
function readCachedPluginToolDescriptors(cacheKey) {
	return descriptorCache.get(cacheKey);
}
function writeCachedPluginToolDescriptors(params) {
	if (!descriptorCache.has(params.cacheKey) && descriptorCache.size >= PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT) {
		const oldestKey = descriptorCache.keys().next().value;
		if (oldestKey !== void 0) descriptorCache.delete(oldestKey);
	}
	descriptorCache.set(params.cacheKey, [...params.descriptors]);
}
//#endregion
//#region src/plugins/tools.ts
const log = createSubsystemLogger("plugins/tools");
const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5e3;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1e3;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;
const pluginToolMeta = /* @__PURE__ */ new WeakMap();
function setPluginToolMeta(tool, meta) {
	pluginToolMeta.set(tool, meta);
}
function getPluginToolMeta(tool) {
	return pluginToolMeta.get(tool);
}
function copyPluginToolMeta(source, target) {
	const meta = pluginToolMeta.get(source);
	if (meta) pluginToolMeta.set(target, meta);
}
/**
* Builds a collision-proof key for plugin-owned tool metadata lookups.
*/
function buildPluginToolMetadataKey(pluginId, toolName) {
	return JSON.stringify([pluginId, toolName]);
}
function normalizeAllowlist(list) {
	return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}
function normalizeDenylist(list) {
	return compileGlobPatterns({
		raw: list,
		normalize: normalizeToolName
	});
}
function denylistBlocksName(name, denylist) {
	const normalized = normalizeToolName(name);
	return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
}
function denylistBlocksPlugin(params) {
	return denylistBlocksName(params.pluginId, params.denylist) || matchesAnyGlobPattern("group:plugins", params.denylist);
}
function denylistBlocksPluginTool(params) {
	return denylistBlocksPlugin({
		pluginId: params.pluginId,
		denylist: params.denylist
	}) || denylistBlocksName(params.toolName, params.denylist);
}
function allowlistIncludesDefaultPluginTools(allowlist) {
	return allowlist.size === 0 || allowlist.has("__openclaw_default_plugin_tools__");
}
function isManifestToolOptional(plugin, toolName) {
	return plugin.toolMetadata?.[toolName]?.optional === true;
}
function isPluginToolOptional(params) {
	return params.entry.optional || (params.manifestPlugin ? isManifestToolOptional(params.manifestPlugin, params.toolName) : false);
}
function isOptionalToolAllowed(params) {
	if (params.allowlist.size === 0) return false;
	if (params.allowlist.has("*")) return true;
	const toolName = normalizeToolName(params.toolName);
	if (params.allowlist.has(toolName)) return true;
	const pluginKey = normalizeToolName(params.pluginId);
	if (params.allowlist.has(pluginKey)) return true;
	return params.allowlist.has("group:plugins");
}
function isOptionalToolEntryPotentiallyAllowed(params) {
	if (params.allowlist.size === 0) return false;
	if (params.allowlist.has("*")) return true;
	const pluginKey = normalizeToolName(params.pluginId);
	if (params.allowlist.has(pluginKey) || params.allowlist.has("group:plugins")) return true;
	if (params.names.length === 0) return true;
	return params.names.some((name) => params.allowlist.has(normalizeToolName(name)));
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readPluginToolName(tool) {
	if (!isRecord(tool)) return "";
	return typeof tool.name === "string" ? tool.name.trim() : "";
}
function toElapsedMs(value) {
	return Math.max(0, Math.round(value));
}
function describePluginToolFactoryResult(resolved, failed) {
	if (failed) return {
		result: "error",
		resultCount: 0
	};
	if (!resolved) return {
		result: "null",
		resultCount: 0
	};
	if (Array.isArray(resolved)) return {
		result: "array",
		resultCount: resolved.length
	};
	return {
		result: "single",
		resultCount: 1
	};
}
function createPluginToolFactoryTiming(params) {
	const result = describePluginToolFactoryResult(params.resolved, params.failed);
	return {
		pluginId: params.pluginId,
		names: params.names,
		durationMs: params.durationMs,
		elapsedMs: params.elapsedMs,
		result: result.result,
		resultCount: result.resultCount,
		optional: params.optional
	};
}
function resolvePluginToolFactoryEntry(params) {
	let resolved = null;
	let failed = false;
	const factoryStartedAt = Date.now();
	try {
		resolved = params.entry.factory(params.ctx);
	} catch (err) {
		failed = true;
		params.logError(`plugin tool failed (${params.entry.pluginId}): ${String(err)}`);
	}
	const factoryEndedAt = Date.now();
	return {
		resolved,
		failed,
		timing: createPluginToolFactoryTiming({
			pluginId: params.entry.pluginId,
			names: params.declaredNames,
			durationMs: toElapsedMs(factoryEndedAt - factoryStartedAt),
			elapsedMs: toElapsedMs(factoryEndedAt - params.factoryTimingStartedAt),
			resolved,
			failed,
			optional: params.entry.optional
		})
	};
}
function formatPluginToolFactoryTiming(timing) {
	const names = timing.names.length > 0 ? timing.names.join("|") : "-";
	return [
		`${timing.pluginId}:${timing.durationMs}ms@${timing.elapsedMs}ms`,
		`names=[${names}]`,
		`result=${timing.result}`,
		`count=${timing.resultCount}`,
		`optional=${String(timing.optional)}`
	].join(" ");
}
function formatPluginToolFactoryTimingSummary(params) {
	const ranked = params.timings.toSorted((left, right) => right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId)).slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
	const omitted = Math.max(0, params.timings.length - ranked.length);
	const factories = ranked.length > 0 ? ranked.map((timing) => formatPluginToolFactoryTiming(timing)).join(", ") : "none";
	return [
		"[trace:plugin-tools] factory timings",
		`totalMs=${params.totalMs}`,
		`factoryCount=${params.timings.length}`,
		`shown=${ranked.length}`,
		`omitted=${omitted}`,
		`factories=${factories}`
	].join(" ");
}
function shouldWarnPluginToolFactoryTimings(params) {
	return params.totalMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS || params.timings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS);
}
function describeMalformedPluginTool(tool) {
	if (!isRecord(tool)) return "tool must be an object";
	const name = readPluginToolName(tool);
	if (!name) return "missing non-empty name";
	if (typeof tool.execute !== "function") return `${name} missing execute function`;
	if (!isRecord(tool.parameters)) return `${name} missing parameters object`;
}
function pluginToolNamesMatchAllowlist(params) {
	if (!params.optional && allowlistIncludesDefaultPluginTools(params.allowlist)) return true;
	return isOptionalToolEntryPotentiallyAllowed(params);
}
function listManifestToolNamesForAllowlist(params) {
	if (params.toolNames.length === 0) return [];
	if (params.allowlist.has("*") || params.allowlist.has("group:plugins")) return [...params.toolNames];
	const pluginKey = normalizeToolName(params.pluginId);
	if (params.allowlist.has(pluginKey)) return [...params.toolNames];
	const matchedToolNames = params.toolNames.filter((name) => params.allowlist.has(normalizeToolName(name)));
	if (!allowlistIncludesDefaultPluginTools(params.allowlist)) return matchedToolNames;
	const defaultToolNames = params.toolNames.filter((name) => !isManifestToolOptional(params.plugin, name));
	return [...new Set([...defaultToolNames, ...matchedToolNames])];
}
function listManifestToolNamesForAvailability(params) {
	return listManifestToolNamesForAllowlist(params);
}
function isManifestToolNameAvailable(params) {
	return hasManifestToolAvailability({
		plugin: params.plugin,
		toolNames: [params.toolName],
		config: params.config,
		env: params.env,
		hasAuthForProvider: params.hasAuthForProvider
	});
}
function filterManifestToolNamesForAvailability(params) {
	return params.toolNames.filter((toolName) => isManifestToolNameAvailable({
		plugin: params.plugin,
		toolName,
		config: params.config,
		env: params.env,
		hasAuthForProvider: params.hasAuthForProvider
	}));
}
function resolvePluginToolRuntimePluginIds(params) {
	const pluginIds = /* @__PURE__ */ new Set();
	const allowlist = normalizeAllowlist(params.toolAllowlist);
	const denylist = normalizeDenylist(params.toolDenylist);
	const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
	const snapshot = params.snapshot ?? loadManifestContractSnapshot({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	for (const plugin of snapshot.plugins) {
		if (!isManifestPluginAvailableForControlPlane({
			snapshot,
			plugin,
			config: params.config
		})) continue;
		if (normalizedPlugins.entries[plugin.id]?.enabled === false || normalizedPlugins.deny.includes(plugin.id)) continue;
		if (denylistBlocksPlugin({
			pluginId: plugin.id,
			denylist
		})) continue;
		const selectedToolNames = listManifestToolNamesForAvailability({
			toolNames: plugin.contracts?.tools ?? [],
			plugin,
			pluginId: plugin.id,
			allowlist
		}).filter((toolName) => !denylistBlocksPluginTool({
			pluginId: plugin.id,
			toolName,
			denylist
		}));
		if (selectedToolNames.length > 0 && hasManifestToolAvailability({
			plugin,
			toolNames: selectedToolNames,
			config: params.availabilityConfig ?? params.config,
			env: params.env,
			hasAuthForProvider: params.hasAuthForProvider
		})) pluginIds.add(plugin.id);
	}
	return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}
function readPluginCacheSource(plugin) {
	const source = plugin.source;
	if (typeof source === "string" && source.trim()) return source;
	const manifestPath = plugin.manifestPath;
	if (typeof manifestPath === "string" && manifestPath.trim()) return manifestPath;
	return plugin.id;
}
function buildPluginDescriptorCacheKey(params) {
	return buildPluginToolDescriptorCacheKey({
		pluginId: params.plugin.id,
		source: readPluginCacheSource(params.plugin),
		rootDir: params.plugin.rootDir,
		contractToolNames: params.plugin.contracts?.tools ?? [],
		ctx: params.ctx,
		currentRuntimeConfig: params.currentRuntimeConfig,
		configCacheKeyMemo: params.configCacheKeyMemo
	});
}
function cachedDescriptorsCoverToolNames(params) {
	const descriptorNames = new Set(params.descriptors.map((entry) => normalizeToolName(entry.descriptor.name)));
	return params.toolNames.every((name) => descriptorNames.has(normalizeToolName(name)));
}
function createCachedDescriptorPluginTool(params) {
	const { descriptor } = params.descriptor;
	const pluginId = descriptor.owner.kind === "plugin" ? descriptor.owner.pluginId : "";
	const toolName = descriptor.name;
	const tool = {
		name: descriptor.name,
		label: descriptor.title ?? descriptor.name,
		description: descriptor.description,
		parameters: descriptor.inputSchema,
		async execute(toolCallId, executeParams, signal, onUpdate) {
			const candidates = resolvePluginToolRegistry({
				loadOptions: buildPluginRuntimeLoadOptions(params.loadContext, {
					activate: false,
					toolDiscovery: true,
					onlyPluginIds: [pluginId],
					...params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}
				}),
				onlyPluginIds: [pluginId]
			})?.tools.filter((candidate) => candidate.pluginId === pluginId);
			if (!candidates || candidates.length === 0) throw new Error(`plugin tool runtime unavailable (${pluginId}): ${toolName}`);
			const requestedToolName = normalizeToolName(toolName);
			const resolveCandidateTool = (candidate) => {
				const resolved = candidate.factory(params.ctx);
				const listRaw = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
				for (const toolRaw of listRaw) {
					const malformedReason = describeMalformedPluginTool(toolRaw);
					if (malformedReason) throw new Error(`plugin tool is malformed (${pluginId}): ${malformedReason}`);
					const runtimeTool = toolRaw;
					if (normalizeToolName(runtimeTool.name) === requestedToolName) return runtimeTool;
				}
			};
			const matchingNamedCandidates = candidates.filter((candidate) => candidate.names.length > 0 && candidate.names.some((name) => normalizeToolName(name) === requestedToolName));
			const unnamedCandidates = candidates.filter((candidate) => candidate.names.length === 0);
			for (const candidate of [...matchingNamedCandidates, ...unnamedCandidates]) {
				let matchedTool;
				try {
					matchedTool = resolveCandidateTool(candidate);
				} catch {
					continue;
				}
				if (matchedTool) return matchedTool.execute(toolCallId, executeParams, signal, onUpdate);
			}
			throw new Error(`plugin tool runtime missing (${pluginId}): ${toolName}`);
		}
	};
	if (params.descriptor.displaySummary) tool.displaySummary = params.descriptor.displaySummary;
	setPluginToolMeta(tool, {
		pluginId,
		optional: params.descriptor.optional
	});
	return tool;
}
function resolveCachedPluginTools(params) {
	const tools = [];
	const handledPluginIds = /* @__PURE__ */ new Set();
	const onlyPluginIdSet = new Set(params.onlyPluginIds);
	for (const plugin of params.snapshot.plugins) {
		if (!onlyPluginIdSet.has(plugin.id)) continue;
		if (denylistBlocksPlugin({
			pluginId: plugin.id,
			denylist: params.denylist
		})) continue;
		if (!isManifestPluginAvailableForControlPlane({
			snapshot: params.snapshot,
			plugin,
			config: params.config
		})) continue;
		const availableToolNames = filterManifestToolNamesForAvailability({
			plugin,
			toolNames: listManifestToolNamesForAvailability({
				plugin,
				toolNames: plugin.contracts?.tools ?? [],
				pluginId: plugin.id,
				allowlist: params.allowlist
			}).filter((toolName) => !denylistBlocksPluginTool({
				pluginId: plugin.id,
				toolName,
				denylist: params.denylist
			})),
			config: params.availabilityConfig,
			env: params.env,
			hasAuthForProvider: params.hasAuthForProvider
		});
		if (availableToolNames.length === 0) continue;
		if (params.existingNormalized.has(normalizeToolName(plugin.id))) continue;
		const cached = readCachedPluginToolDescriptors(buildPluginDescriptorCacheKey({
			plugin,
			ctx: params.ctx,
			currentRuntimeConfig: params.currentRuntimeConfig,
			configCacheKeyMemo: params.configCacheKeyMemo
		}));
		if (!cached || !cachedDescriptorsCoverToolNames({
			descriptors: cached,
			toolNames: availableToolNames
		})) continue;
		const pluginTools = [];
		let hasNameConflict = false;
		const localNormalizedNames = /* @__PURE__ */ new Set();
		for (const cachedDescriptor of cached) {
			if (!cachedDescriptor.optional && !availableToolNames.some((name) => normalizeToolName(name) === normalizeToolName(cachedDescriptor.descriptor.name))) continue;
			if (cachedDescriptor.optional && !isOptionalToolAllowed({
				toolName: cachedDescriptor.descriptor.name,
				pluginId: plugin.id,
				allowlist: params.allowlist
			})) continue;
			const normalizedDescriptorName = normalizeToolName(cachedDescriptor.descriptor.name);
			if (denylistBlocksPluginTool({
				pluginId: plugin.id,
				toolName: cachedDescriptor.descriptor.name,
				denylist: params.denylist
			})) continue;
			if (localNormalizedNames.has(normalizedDescriptorName) || params.existingNormalized.has(normalizedDescriptorName)) {
				hasNameConflict = true;
				break;
			}
			localNormalizedNames.add(normalizedDescriptorName);
			pluginTools.push(createCachedDescriptorPluginTool({
				descriptor: cachedDescriptor,
				ctx: params.ctx,
				loadContext: params.loadContext,
				runtimeOptions: params.runtimeOptions
			}));
		}
		if (hasNameConflict) continue;
		for (const pluginTool of pluginTools) {
			params.existing.add(pluginTool.name);
			params.existingNormalized.add(normalizeToolName(pluginTool.name));
			tools.push(pluginTool);
		}
		handledPluginIds.add(plugin.id);
	}
	return {
		tools,
		handledPluginIds
	};
}
function resolvePluginToolRegistry(params) {
	const lookup = {
		env: params.loadOptions.env,
		loadOptions: params.loadOptions,
		workspaceDir: params.loadOptions.workspaceDir,
		requiredPluginIds: params.onlyPluginIds
	};
	const channelRegistry = getLoadedRuntimePluginRegistry({
		...lookup,
		surface: "channel"
	});
	if (registryHasScopedPluginTools(channelRegistry, params.onlyPluginIds)) return channelRegistry;
	const activeRegistry = getLoadedRuntimePluginRegistry({
		env: lookup.env,
		workspaceDir: lookup.workspaceDir,
		requiredPluginIds: lookup.requiredPluginIds,
		surface: "active"
	});
	if (registryHasScopedPluginTools(activeRegistry, params.onlyPluginIds)) return activeRegistry;
	const forceStandaloneLoad = Boolean(channelRegistry || activeRegistry);
	const standaloneRegistry = ensureStandaloneRuntimePluginRegistryLoaded({
		surface: "active",
		forceLoad: forceStandaloneLoad,
		installRegistry: !forceStandaloneLoad,
		requiredPluginIds: params.onlyPluginIds,
		loadOptions: params.loadOptions
	});
	if (registryHasScopedPluginTools(standaloneRegistry, params.onlyPluginIds)) return standaloneRegistry;
	return standaloneRegistry ?? channelRegistry ?? activeRegistry;
}
function registryHasScopedPluginTools(registry, pluginIds) {
	if (!registry) return false;
	if (pluginIds === void 0) return (registry.tools?.length ?? 0) > 0;
	const scopedPluginIds = new Set(pluginIds);
	if (scopedPluginIds.size === 0) return true;
	const registryPluginIds = new Set(registry.tools.map((entry) => entry.pluginId));
	return Array.from(scopedPluginIds).every((pluginId) => registryPluginIds.has(pluginId));
}
function resolvePluginToolLoadState(params) {
	const env = params.env ?? process.env;
	const context = resolvePluginRuntimeLoadContext({
		config: applyTestPluginDefaults(params.context.config ?? {}, env),
		env,
		workspaceDir: params.context.workspaceDir
	});
	if (!normalizePluginsConfig(context.config.plugins).enabled) return;
	const runtimeOptions = params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : void 0;
	const snapshot = loadManifestContractSnapshot({
		config: context.config,
		workspaceDir: context.workspaceDir,
		env
	});
	const onlyPluginIds = resolvePluginToolRuntimePluginIds({
		config: context.config,
		availabilityConfig: params.context.runtimeConfig ?? context.config,
		workspaceDir: context.workspaceDir,
		env,
		toolAllowlist: params.toolAllowlist,
		toolDenylist: params.toolDenylist,
		hasAuthForProvider: params.hasAuthForProvider,
		snapshot
	});
	return {
		context,
		env,
		loadOptions: buildPluginRuntimeLoadOptions(context, {
			activate: false,
			toolDiscovery: true,
			onlyPluginIds,
			runtimeOptions
		}),
		onlyPluginIds,
		runtimeOptions,
		snapshot
	};
}
function ensureStandalonePluginToolRegistryLoaded(params) {
	const loadState = resolvePluginToolLoadState(params);
	if (!loadState) return;
	ensureStandaloneRuntimePluginRegistryLoaded({
		surface: "channel",
		requiredPluginIds: loadState.onlyPluginIds,
		loadOptions: loadState.loadOptions
	});
}
function resolvePluginTools(params) {
	const loadState = resolvePluginToolLoadState(params);
	if (!loadState) return [];
	const { context, env, onlyPluginIds, runtimeOptions, snapshot } = loadState;
	const tools = [];
	const existing = params.existingToolNames ?? /* @__PURE__ */ new Set();
	const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
	const allowlist = normalizeAllowlist(params.toolAllowlist);
	const denylist = normalizeDenylist(params.toolDenylist);
	const configCacheKeyMemo = createPluginToolDescriptorConfigCacheKeyMemo();
	let currentRuntimeConfigForDescriptorCache = params.context.runtimeConfig;
	if (currentRuntimeConfigForDescriptorCache === void 0 && params.context.getRuntimeConfig) try {
		currentRuntimeConfigForDescriptorCache = params.context.getRuntimeConfig();
	} catch {
		currentRuntimeConfigForDescriptorCache = null;
	}
	const cached = resolveCachedPluginTools({
		snapshot,
		config: context.config,
		availabilityConfig: params.context.runtimeConfig ?? context.config,
		env,
		allowlist,
		denylist,
		hasAuthForProvider: params.hasAuthForProvider,
		onlyPluginIds,
		existing,
		existingNormalized,
		ctx: params.context,
		loadContext: context,
		runtimeOptions,
		currentRuntimeConfig: currentRuntimeConfigForDescriptorCache,
		configCacheKeyMemo
	});
	tools.push(...cached.tools);
	const runtimePluginIds = onlyPluginIds.filter((pluginId) => !cached.handledPluginIds.has(pluginId));
	if (runtimePluginIds.length === 0) return tools;
	const loadOptions = buildPluginRuntimeLoadOptions(context, {
		activate: false,
		toolDiscovery: true,
		onlyPluginIds: runtimePluginIds,
		runtimeOptions
	});
	let registry = resolvePluginToolRegistry({
		loadOptions,
		onlyPluginIds: runtimePluginIds
	});
	if (!registry) {
		try {
			ensureStandaloneRuntimePluginRegistryLoaded({
				surface: "channel",
				requiredPluginIds: runtimePluginIds,
				loadOptions
			});
		} catch (error) {
			context.logger.error(`failed to cold-load plugin tool registry for plugin ids [${runtimePluginIds.join(", ")}]: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		registry = resolvePluginToolRegistry({
			loadOptions,
			onlyPluginIds: runtimePluginIds
		});
		if (!registry) {
			context.logger.warn(`plugin tool registry still unavailable after cold load for plugin ids [${runtimePluginIds.join(", ")}]`);
			return tools;
		}
	}
	const scopedPluginIds = new Set(runtimePluginIds);
	const registryToolPluginIds = new Set(registry.tools.map((entry) => entry.pluginId));
	const missingRegistryToolPluginIds = runtimePluginIds.filter((pluginId) => !registryToolPluginIds.has(pluginId));
	for (const pluginId of missingRegistryToolPluginIds) registry.diagnostics.push({
		level: "warn",
		pluginId,
		source: "plugin-tools",
		message: `plugin tool registry did not include selected plugin tools after cold load (${pluginId})`
	});
	const blockedPlugins = /* @__PURE__ */ new Set();
	const factoryTimingStartedAt = Date.now();
	const factoryTimings = [];
	const capturedDescriptorsByPluginId = /* @__PURE__ */ new Map();
	const manifestPluginsById = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));
	for (const entry of registry.tools) {
		if (!scopedPluginIds.has(entry.pluginId)) continue;
		if (denylistBlocksPlugin({
			pluginId: entry.pluginId,
			denylist
		})) continue;
		if (blockedPlugins.has(entry.pluginId)) continue;
		const pluginIdKey = normalizeToolName(entry.pluginId);
		if (existingNormalized.has(pluginIdKey)) {
			const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
			if (!params.suppressNameConflicts) {
				context.logger.error(message);
				registry.diagnostics.push({
					level: "error",
					pluginId: entry.pluginId,
					source: entry.source,
					message
				});
			}
			blockedPlugins.add(entry.pluginId);
			continue;
		}
		const manifestPlugin = manifestPluginsById.get(entry.pluginId);
		const declaredNames = entry.names ?? [];
		const availabilityNames = declaredNames.length > 0 ? declaredNames : entry.declaredNames ?? [];
		const allowlistNames = manifestPlugin ? filterManifestToolNamesForAvailability({
			plugin: manifestPlugin,
			toolNames: availabilityNames,
			config: params.context.runtimeConfig ?? context.config,
			env,
			hasAuthForProvider: params.hasAuthForProvider
		}).filter((toolName) => !denylistBlocksPluginTool({
			pluginId: entry.pluginId,
			toolName,
			denylist
		})) : declaredNames;
		if (manifestPlugin && availabilityNames.length > 0 && allowlistNames.length === 0) continue;
		if (!pluginToolNamesMatchAllowlist({
			names: allowlistNames,
			pluginId: entry.pluginId,
			optional: entry.optional,
			allowlist
		})) continue;
		const factoryResult = resolvePluginToolFactoryEntry({
			entry,
			ctx: params.context,
			declaredNames,
			factoryTimingStartedAt,
			logError: (message) => context.logger.error(message)
		});
		factoryTimings.push(factoryResult.timing);
		if (factoryResult.failed) continue;
		const { resolved } = factoryResult;
		if (!resolved) {
			if (declaredNames.length > 0) context.logger.debug?.(`plugin tool factory returned null (${entry.pluginId}): [${declaredNames.join(", ")}]`);
			continue;
		}
		const listRaw = Array.isArray(resolved) ? resolved : [resolved];
		const selectedManifestToolNames = manifestPlugin && availabilityNames.length > 0 ? new Set(allowlistNames.map((name) => normalizeToolName(name))) : void 0;
		const manifestContractToolNames = manifestPlugin && availabilityNames.length > 0 ? new Set(availabilityNames.map((name) => normalizeToolName(name))) : void 0;
		const policyAvailableList = (manifestPlugin ? listRaw.filter((tool) => {
			const toolName = readPluginToolName(tool);
			const normalizedToolName = normalizeToolName(toolName);
			if (isManifestToolOptional(manifestPlugin, toolName) && !isOptionalToolAllowed({
				toolName,
				pluginId: entry.pluginId,
				allowlist
			})) return false;
			if (selectedManifestToolNames && manifestContractToolNames?.has(normalizedToolName) && !selectedManifestToolNames.has(normalizedToolName)) return false;
			return isManifestToolNameAvailable({
				plugin: manifestPlugin,
				toolName,
				config: params.context.runtimeConfig ?? context.config,
				env,
				hasAuthForProvider: params.hasAuthForProvider
			});
		}) : listRaw).filter((tool) => !denylistBlocksPluginTool({
			pluginId: entry.pluginId,
			toolName: readPluginToolName(tool),
			denylist
		}));
		const list = entry.optional ? policyAvailableList.filter((tool) => isOptionalToolAllowed({
			toolName: readPluginToolName(tool),
			pluginId: entry.pluginId,
			allowlist
		})) : policyAvailableList;
		if (list.length === 0) continue;
		const normalizedNameSet = /* @__PURE__ */ new Set();
		for (const toolRaw of list) {
			const malformedReason = describeMalformedPluginTool(toolRaw);
			if (malformedReason) {
				const message = `plugin tool is malformed (${entry.pluginId}): ${malformedReason}`;
				context.logger.error(message);
				registry.diagnostics.push({
					level: "error",
					pluginId: entry.pluginId,
					source: entry.source,
					message
				});
				continue;
			}
			const tool = toolRaw;
			const undeclared = entry.declaredNames ? findUndeclaredPluginToolNames({
				declaredNames: entry.declaredNames,
				toolNames: [tool.name]
			}) : [];
			if (undeclared.length > 0) {
				const message = `plugin tool is undeclared (${entry.pluginId}): ${undeclared.join(", ")}`;
				context.logger.error(message);
				registry.diagnostics.push({
					level: "error",
					pluginId: entry.pluginId,
					source: entry.source,
					message
				});
				continue;
			}
			const normalizedToolName = normalizeToolName(tool.name);
			if (normalizedNameSet.has(normalizedToolName) || existingNormalized.has(normalizedToolName)) {
				const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
				if (!params.suppressNameConflicts) {
					context.logger.error(message);
					registry.diagnostics.push({
						level: "error",
						pluginId: entry.pluginId,
						source: entry.source,
						message
					});
				}
				continue;
			}
			normalizedNameSet.add(normalizedToolName);
			existing.add(tool.name);
			existingNormalized.add(normalizedToolName);
			const optional = isPluginToolOptional({
				entry,
				manifestPlugin,
				toolName: tool.name
			});
			pluginToolMeta.set(tool, {
				pluginId: entry.pluginId,
				optional
			});
			if (manifestPlugin) {
				const capturedDescriptors = capturedDescriptorsByPluginId.get(entry.pluginId) ?? [];
				capturedDescriptors.push(capturePluginToolDescriptor({
					pluginId: entry.pluginId,
					tool,
					optional
				}));
				capturedDescriptorsByPluginId.set(entry.pluginId, capturedDescriptors);
			}
			tools.push(tool);
		}
	}
	for (const [pluginId, descriptors] of capturedDescriptorsByPluginId) {
		const manifestPlugin = manifestPluginsById.get(pluginId);
		if (!manifestPlugin) continue;
		if (cachedDescriptorsCoverToolNames({
			descriptors,
			toolNames: listManifestToolNamesForAvailability({
				plugin: manifestPlugin,
				toolNames: manifestPlugin.contracts?.tools ?? [],
				pluginId,
				allowlist
			}).filter((toolName) => !denylistBlocksPluginTool({
				pluginId,
				toolName,
				denylist
			}))
		})) writeCachedPluginToolDescriptors({
			cacheKey: buildPluginDescriptorCacheKey({
				plugin: manifestPlugin,
				ctx: params.context,
				currentRuntimeConfig: currentRuntimeConfigForDescriptorCache,
				configCacheKeyMemo
			}),
			descriptors
		});
	}
	if (factoryTimings.length > 0) {
		const timingSummary = {
			totalMs: factoryTimings.at(-1)?.elapsedMs ?? toElapsedMs(Date.now() - factoryTimingStartedAt),
			timings: factoryTimings
		};
		if (shouldWarnPluginToolFactoryTimings(timingSummary)) log.warn(formatPluginToolFactoryTimingSummary(timingSummary));
		else if (log.isEnabled("trace")) log.trace(formatPluginToolFactoryTimingSummary(timingSummary));
	}
	return tools;
}
//#endregion
export { resolvePluginTools as a, getPluginToolMeta as i, copyPluginToolMeta as n, setPluginToolMeta as o, ensureStandalonePluginToolRegistryLoaded as r, resetPluginToolDescriptorCache as s, buildPluginToolMetadataKey as t };
