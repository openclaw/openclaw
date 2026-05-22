import { a as coerceSecretRef } from "./types.secrets-CyuYZNvB.js";
import { o as normalizePluginsConfig, t as applyTestPluginDefaults } from "./config-state-6n1ivR82.js";
import { l as resolveDefaultSecretProviderAlias } from "./ref-contract-3qf-jsau.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import { h as resolveRuntimeConfigCacheKey } from "./runtime-snapshot-BXa0Udtg.js";
import { a as loadManifestContractSnapshot, n as isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility-DWkPvc9L.js";
import { t as findUndeclaredPluginToolNames } from "./tool-contracts-C0-Hh9_x.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-MUuBvzL0.js";
import { i as resolvePluginRuntimeLoadContext, t as buildPluginRuntimeLoadOptions } from "./load-context-Brio9Jtl.js";
import { i as normalizeToolName } from "./tool-policy-shared-ywrO5Obc.js";
import "./tool-policy-Gps1tVLh.js";
import { t as ensureStandaloneRuntimePluginRegistryLoaded } from "./standalone-runtime-registry-loader-mwmi6moY.js";
import fs from "node:fs";
//#region src/plugins/manifest-tool-availability.ts
function isRecord$1(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function readPath(root, path) {
	if (!path?.trim()) return root;
	let current = root;
	for (const segment of path.split(".")) {
		const key = segment.trim();
		if (!key) return;
		if (!isRecord$1(current) || !(key in current)) return;
		current = current[key];
	}
	return current;
}
function readStringAtPath(root, path) {
	const value = readPath(root, path);
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readEffectiveConfig(params) {
	const root = readPath(params.config, params.rootPath);
	if (!isRecord$1(root)) return;
	const overlay = readPath(root, params.overlayPath);
	return isRecord$1(overlay) ? {
		...root,
		...overlay
	} : root;
}
function hasConfiguredSecretRefInConfigPath(params) {
	const providerConfig = params.config?.secrets?.providers?.[params.ref.provider];
	if (params.ref.source !== "env") return Boolean(providerConfig && providerConfig.source === params.ref.source);
	if (!providerConfig) return params.ref.provider === resolveDefaultSecretProviderAlias(params.config ?? {}, "env");
	if (providerConfig.source !== "env") return false;
	const allowlist = providerConfig.allowlist;
	return !allowlist || allowlist.includes(params.ref.id);
}
function hasConfiguredValue(params) {
	const secretRef = coerceSecretRef(params.value, params.config?.secrets?.defaults);
	if (secretRef) return hasConfiguredSecretRefInConfigPath({
		config: params.config,
		env: params.env,
		ref: secretRef
	}) && (secretRef.source !== "env" || Boolean(params.env[secretRef.id]?.trim()));
	if (typeof params.value === "string") return params.value.trim().length > 0;
	if (Array.isArray(params.value)) return params.value.length > 0;
	if (isRecord$1(params.value)) return Object.keys(params.value).length > 0;
	return params.value !== void 0 && params.value !== null;
}
function manifestConfigSignalPasses(params) {
	const effectiveConfig = readEffectiveConfig({
		config: params.config,
		rootPath: params.signal.rootPath,
		overlayPath: params.signal.overlayPath
	});
	if (!effectiveConfig) return false;
	const modeSignal = params.signal.mode;
	if (modeSignal) {
		const mode = readStringAtPath(effectiveConfig, modeSignal.path?.trim() || "mode") ?? modeSignal.default;
		if (!mode) return false;
		if (modeSignal.allowed?.length && !modeSignal.allowed.includes(mode)) return false;
		if (modeSignal.disallowed?.includes(mode)) return false;
	}
	for (const requiredPath of params.signal.required ?? []) if (!hasConfiguredValue({
		config: params.config,
		env: params.env,
		value: readPath(effectiveConfig, requiredPath)
	})) return false;
	const requiredAny = params.signal.requiredAny ?? [];
	if (requiredAny.length > 0 && !requiredAny.some((path) => hasConfiguredValue({
		config: params.config,
		env: params.env,
		value: readPath(effectiveConfig, path)
	}))) return false;
	return true;
}
function normalizeBaseUrlForManifestGuard(value) {
	return value.trim().replace(/\/+$/, "");
}
function manifestProviderBaseUrlGuardPasses(params) {
	const guard = params.guard;
	if (!guard) return true;
	const providerConfig = params.config?.models?.providers?.[guard.provider];
	const rawBaseUrl = typeof providerConfig?.baseUrl === "string" && providerConfig.baseUrl.trim() ? providerConfig.baseUrl : guard.defaultBaseUrl;
	if (!rawBaseUrl) return false;
	const normalizedBaseUrl = normalizeBaseUrlForManifestGuard(rawBaseUrl);
	return guard.allowedBaseUrls.some((allowedBaseUrl) => normalizeBaseUrlForManifestGuard(allowedBaseUrl) === normalizedBaseUrl);
}
function manifestPluginSetupProviderEnvVars(plugin, providerId) {
	const direct = plugin.setup?.providers?.find((provider) => provider.id === providerId)?.envVars;
	if (direct && direct.length > 0) return direct;
	return plugin.providerAuthEnvVars?.[providerId] ?? [];
}
function hasNonEmptyManifestEnvCandidate(env, envVars) {
	return envVars.some((envVar) => {
		const key = envVar.trim();
		return key.length > 0 && Boolean(env[key]?.trim());
	});
}
function listToolAuthSignals(metadata) {
	if (metadata.authSignals?.length) return metadata.authSignals;
	return [...metadata.authProviders ?? [], ...metadata.aliases ?? []].map((provider) => ({ provider }));
}
function toolMetadataPasses(params) {
	if (params.metadata.configSignals?.some((signal) => manifestConfigSignalPasses({
		config: params.config,
		env: params.env,
		signal
	}))) return true;
	for (const signal of listToolAuthSignals(params.metadata)) {
		if (!manifestProviderBaseUrlGuardPasses({
			config: params.config,
			guard: signal.providerBaseUrl
		})) continue;
		if (params.hasAuthForProvider?.(signal.provider)) return true;
		if (hasNonEmptyManifestEnvCandidate(params.env, manifestPluginSetupProviderEnvVars(params.plugin, signal.provider))) return true;
	}
	return false;
}
function hasManifestToolAvailability(params) {
	for (const toolName of params.toolNames) {
		const metadata = params.plugin.toolMetadata?.[toolName];
		if (!metadata) return true;
		if (toolMetadataPasses({
			plugin: params.plugin,
			metadata,
			config: params.config,
			env: params.env,
			hasAuthForProvider: params.hasAuthForProvider
		})) return true;
	}
	return false;
}
//#endregion
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
function getDescriptorConfigCacheKey(value, memo) {
	if (!value) return null;
	const cached = memo?.get(value);
	if (cached !== void 0) return cached;
	let resolved;
	try {
		resolved = resolveRuntimeConfigCacheKey(value);
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
		sessionKey: ctx.sessionKey ?? null,
		sessionId: ctx.sessionId ?? null,
		browser: ctx.browser ?? null,
		messageChannel: ctx.messageChannel ?? null,
		agentAccountId: ctx.agentAccountId ?? null,
		deliveryContext: ctx.deliveryContext ?? null,
		requesterSenderId: ctx.requesterSenderId ?? null,
		senderIsOwner: ctx.senderIsOwner ?? null,
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
		...params.tool.ownerOnly === true ? { ownerOnly: true } : {},
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
function isOptionalToolAllowed(params) {
	if (params.allowlist.size === 0) return false;
	const toolName = normalizeToolName(params.toolName);
	if (params.allowlist.has(toolName)) return true;
	const pluginKey = normalizeToolName(params.pluginId);
	if (params.allowlist.has(pluginKey)) return true;
	return params.allowlist.has("group:plugins");
}
function isOptionalToolEntryPotentiallyAllowed(params) {
	if (params.allowlist.size === 0) return false;
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
	if (params.allowlist.size === 0) return !params.optional;
	return isOptionalToolEntryPotentiallyAllowed(params);
}
function manifestToolContractMatchesAllowlist(params) {
	if (params.toolNames.length === 0) return false;
	if (params.allowlist.size === 0) return true;
	if (params.allowlist.has("*") || params.allowlist.has("group:plugins")) return true;
	const pluginKey = normalizeToolName(params.pluginId);
	if (params.allowlist.has(pluginKey)) return true;
	return params.toolNames.some((name) => params.allowlist.has(normalizeToolName(name)));
}
function listManifestToolNamesForAvailability(params) {
	if (params.allowlist.size === 0 || params.allowlist.has("*") || params.allowlist.has("group:plugins")) return [...params.toolNames];
	if (params.allowlist.has(normalizeToolName(params.pluginId))) return [...params.toolNames];
	return params.toolNames.filter((name) => params.allowlist.has(normalizeToolName(name)));
}
function resolvePluginToolRuntimePluginIds(params) {
	const pluginIds = /* @__PURE__ */ new Set();
	const allowlist = normalizeAllowlist(params.toolAllowlist);
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
		const toolNames = plugin.contracts?.tools ?? [];
		if (manifestToolContractMatchesAllowlist({
			toolNames,
			pluginId: plugin.id,
			allowlist
		}) && hasManifestToolAvailability({
			plugin,
			toolNames: listManifestToolNamesForAvailability({
				toolNames,
				pluginId: plugin.id,
				allowlist
			}),
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
			const entry = resolvePluginToolRegistry({
				loadOptions: buildPluginRuntimeLoadOptions(params.loadContext, {
					activate: false,
					toolDiscovery: true,
					onlyPluginIds: [pluginId],
					...params.runtimeOptions ? { runtimeOptions: params.runtimeOptions } : {}
				}),
				onlyPluginIds: [pluginId]
			})?.tools.find((candidate) => candidate.pluginId === pluginId && (candidate.names.length > 0 ? candidate.names : candidate.declaredNames ?? []).some((name) => normalizeToolName(name) === normalizeToolName(toolName)));
			if (!entry) throw new Error(`plugin tool runtime unavailable (${pluginId}): ${toolName}`);
			const resolved = entry.factory(params.ctx);
			const listRaw = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
			for (const toolRaw of listRaw) {
				const malformedReason = describeMalformedPluginTool(toolRaw);
				if (malformedReason) throw new Error(`plugin tool is malformed (${pluginId}): ${malformedReason}`);
				const runtimeTool = toolRaw;
				if (normalizeToolName(runtimeTool.name) === normalizeToolName(toolName)) return runtimeTool.execute(toolCallId, executeParams, signal, onUpdate);
			}
			throw new Error(`plugin tool runtime missing (${pluginId}): ${toolName}`);
		}
	};
	if (params.descriptor.displaySummary) tool.displaySummary = params.descriptor.displaySummary;
	if (params.descriptor.ownerOnly === true) tool.ownerOnly = true;
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
		if (!isManifestPluginAvailableForControlPlane({
			snapshot: params.snapshot,
			plugin,
			config: params.config
		})) continue;
		const availableToolNames = listManifestToolNamesForAvailability({
			toolNames: plugin.contracts?.tools ?? [],
			pluginId: plugin.id,
			allowlist: params.allowlist
		});
		if (!hasManifestToolAvailability({
			plugin,
			toolNames: availableToolNames,
			config: params.availabilityConfig,
			env: params.env,
			hasAuthForProvider: params.hasAuthForProvider
		})) continue;
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
		const localNames = /* @__PURE__ */ new Set();
		for (const cachedDescriptor of cached) {
			if (!cachedDescriptor.optional && !availableToolNames.some((name) => normalizeToolName(name) === normalizeToolName(cachedDescriptor.descriptor.name))) continue;
			if (cachedDescriptor.optional && !isOptionalToolAllowed({
				toolName: cachedDescriptor.descriptor.name,
				pluginId: plugin.id,
				allowlist: params.allowlist
			})) continue;
			if (localNames.has(cachedDescriptor.descriptor.name) || params.existing.has(cachedDescriptor.descriptor.name)) {
				hasNameConflict = true;
				break;
			}
			localNames.add(cachedDescriptor.descriptor.name);
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
	return getLoadedRuntimePluginRegistry({
		...lookup,
		surface: "channel"
	}) ?? getLoadedRuntimePluginRegistry({
		env: lookup.env,
		workspaceDir: lookup.workspaceDir,
		requiredPluginIds: lookup.requiredPluginIds,
		surface: "active"
	});
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
	const registry = resolvePluginToolRegistry({
		loadOptions: buildPluginRuntimeLoadOptions(context, {
			activate: false,
			toolDiscovery: true,
			onlyPluginIds: runtimePluginIds,
			runtimeOptions
		}),
		onlyPluginIds: runtimePluginIds
	});
	if (!registry) return tools;
	const scopedPluginIds = new Set(runtimePluginIds);
	const blockedPlugins = /* @__PURE__ */ new Set();
	const factoryTimingStartedAt = Date.now();
	const factoryTimings = [];
	const capturedDescriptorsByPluginId = /* @__PURE__ */ new Map();
	const manifestPluginsById = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));
	for (const entry of registry.tools) {
		if (!scopedPluginIds.has(entry.pluginId)) continue;
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
		const declaredNames = entry.names ?? [];
		if (!pluginToolNamesMatchAllowlist({
			names: declaredNames,
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
		const list = entry.optional ? listRaw.filter((tool) => isOptionalToolAllowed({
			toolName: readPluginToolName(tool),
			pluginId: entry.pluginId,
			allowlist
		})) : listRaw;
		if (list.length === 0) continue;
		const nameSet = /* @__PURE__ */ new Set();
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
			if (nameSet.has(tool.name) || existing.has(tool.name)) {
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
			nameSet.add(tool.name);
			existing.add(tool.name);
			pluginToolMeta.set(tool, {
				pluginId: entry.pluginId,
				optional: entry.optional
			});
			if (manifestPluginsById.get(entry.pluginId)) {
				const capturedDescriptors = capturedDescriptorsByPluginId.get(entry.pluginId) ?? [];
				capturedDescriptors.push(capturePluginToolDescriptor({
					pluginId: entry.pluginId,
					tool,
					optional: entry.optional
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
				toolNames: manifestPlugin.contracts?.tools ?? [],
				pluginId,
				allowlist
			})
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
export { resolvePluginTools as a, hasNonEmptyManifestEnvCandidate as c, manifestProviderBaseUrlGuardPasses as d, getPluginToolMeta as i, manifestConfigSignalPasses as l, copyPluginToolMeta as n, setPluginToolMeta as o, ensureStandalonePluginToolRegistryLoaded as r, resetPluginToolDescriptorCache as s, buildPluginToolMetadataKey as t, manifestPluginSetupProviderEnvVars as u };
