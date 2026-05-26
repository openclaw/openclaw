import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { t as loadChannelSecretContractApi } from "./channel-contract-api-BKyJzTiE.js";
import { o as listSecretTargetRegistryEntries, r as discoverConfigSecretTargetsByIds } from "./target-registry-t5xykQQS.js";
import { o as sortWebFetchProvidersForAutoDetect, r as sortWebSearchProvidersForAutoDetect } from "./web-search-providers.shared-C_XvZwgr.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-CHBMrkWp.js";
import { t as resolvePluginWebFetchProviders } from "./web-fetch-providers.runtime.js";
import { t as resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";
//#region src/cli/command-secret-targets.ts
const STATIC_QR_REMOTE_TARGET_IDS = ["gateway.remote.token", "gateway.remote.password"];
const STATIC_MODEL_TARGET_IDS = [
	"models.providers.*.apiKey",
	"models.providers.*.headers.*",
	"models.providers.*.request.headers.*",
	"models.providers.*.request.auth.token",
	"models.providers.*.request.auth.value",
	"models.providers.*.request.proxy.tls.ca",
	"models.providers.*.request.proxy.tls.cert",
	"models.providers.*.request.proxy.tls.key",
	"models.providers.*.request.proxy.tls.passphrase",
	"models.providers.*.request.tls.ca",
	"models.providers.*.request.tls.cert",
	"models.providers.*.request.tls.key",
	"models.providers.*.request.tls.passphrase"
];
const STATIC_AGENT_RUNTIME_BASE_TARGET_IDS = [
	...STATIC_MODEL_TARGET_IDS,
	"agents.defaults.memorySearch.remote.apiKey",
	"agents.list[].memorySearch.remote.apiKey",
	"agents.list[].tts.providers.*.apiKey",
	"messages.tts.providers.*.apiKey",
	"skills.entries.*.apiKey",
	"tools.web.search.apiKey",
	"tools.web.fetch.firecrawl.apiKey"
];
const STATIC_MEMORY_EMBEDDING_TARGET_IDS = [
	...STATIC_MODEL_TARGET_IDS,
	"agents.defaults.memorySearch.remote.apiKey",
	"agents.list[].memorySearch.remote.apiKey"
];
const STATIC_TTS_TARGET_IDS = [
	...STATIC_MODEL_TARGET_IDS,
	"agents.list[].tts.providers.*.apiKey",
	"messages.tts.providers.*.apiKey"
];
const STATIC_STATUS_TARGET_IDS = ["agents.defaults.memorySearch.remote.apiKey", "agents.list[].memorySearch.remote.apiKey"];
const STATIC_SECURITY_AUDIT_TARGET_IDS = [
	"gateway.auth.token",
	"gateway.auth.password",
	"gateway.remote.token",
	"gateway.remote.password"
];
function idsByPrefix(prefixes) {
	return listSecretTargetRegistryEntries().map((entry) => entry.id).filter((id) => prefixes.some((prefix) => id.startsWith(prefix))).toSorted();
}
const STATIC_CAPABILITY_WEB_SEARCH_TARGET_IDS = ["tools.web.search.apiKey", "tools.web.search.*.apiKey"];
const STATIC_CAPABILITY_WEB_FETCH_TARGET_IDS = ["tools.web.fetch.firecrawl.apiKey"];
let cachedCommandSecretTargets;
let cachedAgentRuntimeBaseTargetIds;
let cachedCapabilityWebFetchTargetIds;
let cachedCapabilityWebSearchTargetIds;
let cachedChannelSecretTargetIds;
function getChannelSecretTargetIds() {
	cachedChannelSecretTargetIds ??= idsByPrefix(["channels."]);
	return cachedChannelSecretTargetIds;
}
function isPluginWebCredentialTargetId(id) {
	const segments = id.split(".");
	if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") return false;
	const configPath = segments.slice(4).join(".");
	return configPath === "webSearch.apiKey" || configPath === "webFetch.apiKey";
}
function isPluginWebSearchCredentialTargetId(id) {
	const segments = id.split(".");
	if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") return false;
	return segments.slice(4).join(".") === "webSearch.apiKey";
}
function isPluginWebFetchCredentialTargetId(id) {
	const segments = id.split(".");
	if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") return false;
	return segments.slice(4).join(".") === "webFetch.apiKey";
}
function getCapabilityWebSearchTargetIds() {
	cachedCapabilityWebSearchTargetIds ??= [...new Set([...STATIC_CAPABILITY_WEB_SEARCH_TARGET_IDS, ...listSecretTargetRegistryEntries().map((entry) => entry.id).filter(isPluginWebSearchCredentialTargetId)])].toSorted();
	return cachedCapabilityWebSearchTargetIds;
}
function getCapabilityWebFetchTargetIds() {
	cachedCapabilityWebFetchTargetIds ??= [...new Set([...STATIC_CAPABILITY_WEB_FETCH_TARGET_IDS, ...listSecretTargetRegistryEntries().map((entry) => entry.id).filter(isPluginWebFetchCredentialTargetId)])].toSorted();
	return cachedCapabilityWebFetchTargetIds;
}
function isConfiguredSecretCandidate(value) {
	if (typeof value === "string") return value.trim().length > 0;
	return value !== void 0 && value !== null;
}
function resolveFetchConfig(config) {
	const fetch = config.tools?.web?.fetch;
	return fetch && typeof fetch === "object" && !Array.isArray(fetch) ? fetch : void 0;
}
function resolveSearchConfig(config) {
	const search = config.tools?.web?.search;
	return search && typeof search === "object" && !Array.isArray(search) ? search : void 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pathPatternMatchesConcretePath(pathPattern, path) {
	const pathSegments = path.split(".");
	const patternSegments = pathPattern.split(".");
	let pathIndex = 0;
	for (const segment of patternSegments) {
		if (segment === "*") {
			if (!pathSegments[pathIndex]) return false;
			pathIndex += 1;
			continue;
		}
		if (segment.endsWith("[]")) {
			const field = segment.slice(0, -2);
			if (pathSegments[pathIndex] !== field || !/^\d+$/.test(pathSegments[pathIndex + 1] ?? "")) return false;
			pathIndex += 2;
			continue;
		}
		if (pathSegments[pathIndex] !== segment) return false;
		pathIndex += 1;
	}
	return pathIndex === pathSegments.length;
}
function targetIdsForConfigPath(path) {
	return listSecretTargetRegistryEntries().filter((entry) => pathPatternMatchesConcretePath(entry.pathPattern ?? entry.id, path)).map((entry) => entry.id).toSorted();
}
function addConfigPathTargets(params) {
	const targetIds = targetIdsForConfigPath(params.path);
	if (targetIds.length === 0) return false;
	for (const targetId of targetIds) {
		params.targetIds.add(targetId);
		if (targetId !== params.path) params.allowedPaths.add(params.path);
	}
	params.targetPaths.add(params.path);
	return true;
}
function addConfiguredConfigPathTargets(params) {
	const targetIds = targetIdsForConfigPath(params.path);
	if (targetIds.length === 0) return false;
	if (!discoverConfigSecretTargetsByIds(params.config, toTargetIdSet(targetIds)).some((target) => target.path === params.path)) return false;
	return addConfigPathTargets(params);
}
function normalizeProviderId(value) {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : void 0;
}
function modelProviderCredentialFallbackPathForWebSearchProvider(providerId) {
	switch (providerId) {
		case "gemini": return "models.providers.google.apiKey";
		case "ollama": return "models.providers.ollama.apiKey";
		default: return;
	}
}
function discoverForcedActivePaths(config, targetIds, allowedPaths) {
	const forcedActivePaths = /* @__PURE__ */ new Set();
	for (const target of discoverConfigSecretTargetsByIds(config, targetIds)) {
		if (allowedPaths && !allowedPaths.has(target.path)) continue;
		forcedActivePaths.add(target.path);
	}
	return forcedActivePaths.size > 0 ? forcedActivePaths : void 0;
}
function discoverConfiguredAllowedPaths(config, targetIds) {
	const allowedPaths = /* @__PURE__ */ new Set();
	for (const target of discoverConfigSecretTargetsByIds(config, targetIds)) allowedPaths.add(target.path);
	return allowedPaths.size > 0 ? allowedPaths : void 0;
}
function mergeConfiguredAllowedPaths(params) {
	const allowedPaths = /* @__PURE__ */ new Set();
	for (const path of discoverConfiguredAllowedPaths(params.config, params.baseTargetIds) ?? []) allowedPaths.add(path);
	for (const path of params.concreteFallbackPaths) allowedPaths.add(path);
	return allowedPaths.size > 0 ? allowedPaths : void 0;
}
function resolveSelectedWebFetchProviderId(config, providerId) {
	return normalizeProviderId(providerId) ?? normalizeProviderId(resolveFetchConfig(config)?.provider);
}
function resolveSelectedWebSearchProviderId(config, providerId) {
	return normalizeProviderId(providerId) ?? normalizeProviderId(resolveSearchConfig(config)?.provider);
}
function withSelectedWebProviderForDiscovery(config, kind, providerId) {
	if (!providerId) return config;
	const next = structuredClone(config);
	const tools = next.tools ??= {};
	const web = tools.web ??= {};
	const existing = web[kind];
	web[kind] = existing && typeof existing === "object" && !Array.isArray(existing) ? {
		...existing,
		provider: providerId
	} : { provider: providerId };
	return next;
}
function hasConfiguredFetchCredential(params) {
	return isConfiguredSecretCandidate(params.provider.getConfiguredCredentialValue?.(params.config)) || isConfiguredSecretCandidate(params.provider.getCredentialValue(resolveFetchConfig(params.config)));
}
function hasConfiguredSearchCredential(params) {
	return isConfiguredSecretCandidate(params.provider.getConfiguredCredentialValue?.(params.config)) || isConfiguredSecretCandidate(params.provider.getCredentialValue(resolveSearchConfig(params.config)));
}
function addConfiguredSearchCredentialTargetIds(params) {
	const searchConfig = resolveSearchConfig(params.config);
	if (!searchConfig) return;
	const configuredCredential = params.provider.getCredentialValue(searchConfig);
	if (!isConfiguredSecretCandidate(configuredCredential)) return;
	const pluginCredential = params.provider.getConfiguredCredentialValue?.(params.config);
	if (isConfiguredSecretCandidate(pluginCredential) && configuredCredential !== pluginCredential) return;
	if (configuredCredential === searchConfig.apiKey) addConfigPathTargets({
		...params,
		path: "tools.web.search.apiKey"
	});
	const scopedConfig = searchConfig[params.provider.id];
	if (isRecord(scopedConfig) && configuredCredential === scopedConfig.apiKey) addConfigPathTargets({
		...params,
		path: `tools.web.search.${params.provider.id}.apiKey`
	});
}
function addConfiguredFetchCredentialTargetIds(params) {
	const fetchConfig = resolveFetchConfig(params.config);
	if (!fetchConfig) return;
	const configuredCredential = params.provider.getCredentialValue(fetchConfig);
	if (!isConfiguredSecretCandidate(configuredCredential)) return;
	const pluginCredential = params.provider.getConfiguredCredentialValue?.(params.config);
	if (isConfiguredSecretCandidate(pluginCredential) && configuredCredential !== pluginCredential) return;
	const scopedConfig = fetchConfig[params.provider.id];
	if (isRecord(scopedConfig) && configuredCredential === scopedConfig.apiKey) addConfigPathTargets({
		...params,
		path: `tools.web.fetch.${params.provider.id}.apiKey`
	});
}
function getCapabilityWebSearchSelectedProviderTargetIds(config, providerId) {
	const selectedProviderId = resolveSelectedWebSearchProviderId(config, providerId);
	if (!selectedProviderId) return {
		matchedProvider: false,
		targetIds: [],
		targetPaths: [],
		allowedPaths: [],
		fallbackTargetIds: [],
		fallbackPaths: []
	};
	const targetIds = /* @__PURE__ */ new Set();
	const targetPaths = /* @__PURE__ */ new Set();
	const allowedPaths = /* @__PURE__ */ new Set();
	const fallbackTargetIds = /* @__PURE__ */ new Set();
	const fallbackPaths = /* @__PURE__ */ new Set();
	const providers = resolvePluginWebSearchProviders({
		config: withSelectedWebProviderForDiscovery(config, "search", normalizeProviderId(providerId)),
		bundledAllowlistCompat: true
	}).filter((provider) => provider.id === selectedProviderId);
	for (const provider of providers) {
		if (provider.credentialPath.trim()) addConfigPathTargets({
			path: provider.credentialPath,
			targetIds,
			targetPaths,
			allowedPaths
		});
		addConfiguredSearchCredentialTargetIds({
			config,
			provider,
			targetIds,
			targetPaths,
			allowedPaths
		});
		if (hasConfiguredSearchCredential({
			provider,
			config
		})) continue;
		const fallbackPath = provider.getConfiguredCredentialFallback?.(config)?.path?.trim();
		if (fallbackPath) {
			const before = new Set(targetIds);
			const added = addConfigPathTargets({
				path: fallbackPath,
				targetIds,
				targetPaths,
				allowedPaths
			});
			for (const targetId of targetIds) if (!before.has(targetId)) fallbackTargetIds.add(targetId);
			if (added) fallbackPaths.add(fallbackPath);
		}
		const modelFallbackPath = modelProviderCredentialFallbackPathForWebSearchProvider(selectedProviderId);
		if (modelFallbackPath && !fallbackPaths.has(modelFallbackPath)) {
			const before = new Set(targetIds);
			const added = addConfiguredConfigPathTargets({
				config,
				path: modelFallbackPath,
				targetIds,
				targetPaths,
				allowedPaths
			});
			for (const targetId of targetIds) if (!before.has(targetId)) fallbackTargetIds.add(targetId);
			if (added) fallbackPaths.add(modelFallbackPath);
		}
	}
	return {
		matchedProvider: providers.length > 0,
		targetIds: [...targetIds].toSorted(),
		targetPaths: [...targetPaths].toSorted(),
		allowedPaths: [...allowedPaths].toSorted(),
		fallbackTargetIds: [...fallbackTargetIds].toSorted(),
		fallbackPaths: [...fallbackPaths].toSorted()
	};
}
function getCapabilityWebFetchSelectedProviderTargetIds(config, providerId) {
	const selectedProviderId = resolveSelectedWebFetchProviderId(config, providerId);
	if (!selectedProviderId) return {
		matchedProvider: false,
		targetIds: [],
		targetPaths: [],
		allowedPaths: [],
		fallbackTargetIds: [],
		fallbackPaths: []
	};
	const targetIds = /* @__PURE__ */ new Set();
	const targetPaths = /* @__PURE__ */ new Set();
	const allowedPaths = /* @__PURE__ */ new Set();
	const fallbackTargetIds = /* @__PURE__ */ new Set();
	const fallbackPaths = /* @__PURE__ */ new Set();
	const providers = resolvePluginWebFetchProviders({
		config: withSelectedWebProviderForDiscovery(config, "fetch", normalizeProviderId(providerId)),
		bundledAllowlistCompat: true
	}).filter((provider) => provider.id === selectedProviderId);
	for (const provider of providers) {
		if (provider.credentialPath.trim()) addConfigPathTargets({
			path: provider.credentialPath,
			targetIds,
			targetPaths,
			allowedPaths
		});
		addConfiguredFetchCredentialTargetIds({
			config,
			provider,
			targetIds,
			targetPaths,
			allowedPaths
		});
		if (hasConfiguredFetchCredential({
			provider,
			config
		})) continue;
		const fallbackPath = provider.getConfiguredCredentialFallback?.(config)?.path?.trim();
		if (fallbackPath) {
			const before = new Set(targetIds);
			const added = addConfigPathTargets({
				path: fallbackPath,
				targetIds,
				targetPaths,
				allowedPaths
			});
			for (const targetId of targetIds) if (!before.has(targetId)) fallbackTargetIds.add(targetId);
			if (added) fallbackPaths.add(fallbackPath);
		}
	}
	return {
		matchedProvider: providers.length > 0,
		targetIds: [...targetIds].toSorted(),
		targetPaths: [...targetPaths].toSorted(),
		allowedPaths: [...allowedPaths].toSorted(),
		fallbackTargetIds: [...fallbackTargetIds].toSorted(),
		fallbackPaths: [...fallbackPaths].toSorted()
	};
}
function getCapabilityWebSearchAutoDetectTargets(config) {
	const baseTargetIds = getCapabilityWebSearchCommandSecretTargetIds();
	const targetIds = new Set(baseTargetIds);
	const fallbackTargetIds = /* @__PURE__ */ new Set();
	const fallbackPaths = /* @__PURE__ */ new Set();
	const providers = sortWebSearchProvidersForAutoDetect(resolvePluginWebSearchProviders({
		config,
		bundledAllowlistCompat: true
	}));
	for (const provider of providers) {
		if (hasConfiguredSearchCredential({
			provider,
			config
		})) break;
		const fallback = provider.getConfiguredCredentialFallback?.(config);
		const fallbackPath = fallback?.path?.trim();
		if (!fallbackPath || !isConfiguredSecretCandidate(fallback?.value)) continue;
		for (const targetId of targetIdsForConfigPath(fallbackPath)) {
			targetIds.add(targetId);
			fallbackTargetIds.add(targetId);
		}
		fallbackPaths.add(fallbackPath);
		break;
	}
	if (fallbackTargetIds.size === 0) return { targetIds };
	const allowedPaths = mergeConfiguredAllowedPaths({
		config,
		baseTargetIds,
		concreteFallbackPaths: fallbackPaths
	});
	const optionalActivePaths = discoverForcedActivePaths(config, fallbackTargetIds, allowedPaths);
	return {
		targetIds,
		...allowedPaths ? { allowedPaths } : {},
		...optionalActivePaths ? { optionalActivePaths } : {}
	};
}
function getCapabilityWebFetchAutoDetectTargets(config) {
	const baseTargetIds = getCapabilityWebFetchCommandSecretTargetIds();
	const targetIds = new Set(baseTargetIds);
	const fallbackTargetIds = /* @__PURE__ */ new Set();
	const fallbackPaths = /* @__PURE__ */ new Set();
	const providers = sortWebFetchProvidersForAutoDetect(resolvePluginWebFetchProviders({
		config,
		bundledAllowlistCompat: true
	}));
	for (const provider of providers) {
		if (hasConfiguredFetchCredential({
			provider,
			config
		})) break;
		const fallback = provider.getConfiguredCredentialFallback?.(config);
		const fallbackPath = fallback?.path?.trim();
		if (!fallbackPath || !isConfiguredSecretCandidate(fallback?.value)) continue;
		for (const targetId of targetIdsForConfigPath(fallbackPath)) {
			targetIds.add(targetId);
			fallbackTargetIds.add(targetId);
		}
		fallbackPaths.add(fallbackPath);
		break;
	}
	if (fallbackTargetIds.size === 0) return { targetIds };
	const allowedPaths = mergeConfiguredAllowedPaths({
		config,
		baseTargetIds,
		concreteFallbackPaths: fallbackPaths
	});
	const optionalActivePaths = discoverForcedActivePaths(config, fallbackTargetIds, allowedPaths);
	return {
		targetIds,
		...allowedPaths ? { allowedPaths } : {},
		...optionalActivePaths ? { optionalActivePaths } : {}
	};
}
function getAgentRuntimeBaseTargetIds() {
	cachedAgentRuntimeBaseTargetIds ??= [...STATIC_AGENT_RUNTIME_BASE_TARGET_IDS, ...listSecretTargetRegistryEntries().map((entry) => entry.id).filter(isPluginWebCredentialTargetId).toSorted()];
	return cachedAgentRuntimeBaseTargetIds;
}
function isScopedChannelSecretTargetEntry(params) {
	const channelId = normalizeOptionalString(params.pluginChannelId);
	if (!channelId) return false;
	const allowedPrefix = `channels.${channelId}.`;
	return params.entry.id.startsWith(allowedPrefix) && params.entry.configFile === "openclaw.json" && typeof params.entry.pathPattern === "string" && params.entry.pathPattern.startsWith(allowedPrefix) && (params.entry.refPathPattern === void 0 || params.entry.refPathPattern.startsWith(allowedPrefix));
}
function getConfiguredChannelSecretTargetIds(config, env = process.env) {
	const targetIds = /* @__PURE__ */ new Set();
	const channels = config.channels;
	if (channels && typeof channels === "object" && !Array.isArray(channels)) for (const channelId of Object.keys(channels)) {
		if (channelId === "defaults") continue;
		const contract = loadChannelSecretContractApi({
			channelId,
			config,
			env
		});
		for (const entry of contract?.secretTargetRegistryEntries ?? []) if (isScopedChannelSecretTargetEntry({
			entry,
			pluginChannelId: channelId
		})) targetIds.add(entry.id);
	}
	for (const plugin of listReadOnlyChannelPluginsForConfig(config, {
		env,
		includePersistedAuthState: false
	})) for (const entry of plugin.secrets?.secretTargetRegistryEntries ?? []) if (isScopedChannelSecretTargetEntry({
		entry,
		pluginChannelId: plugin.id
	})) targetIds.add(entry.id);
	return [...targetIds].toSorted((left, right) => left.localeCompare(right));
}
function buildCommandSecretTargets() {
	const channelTargetIds = getChannelSecretTargetIds();
	return {
		channels: channelTargetIds,
		agentRuntime: [...getAgentRuntimeBaseTargetIds(), ...channelTargetIds],
		status: [...STATIC_STATUS_TARGET_IDS, ...channelTargetIds],
		securityAudit: [...STATIC_SECURITY_AUDIT_TARGET_IDS, ...channelTargetIds]
	};
}
function getCommandSecretTargets() {
	cachedCommandSecretTargets ??= buildCommandSecretTargets();
	return cachedCommandSecretTargets;
}
function toTargetIdSet(values) {
	return new Set(values);
}
function selectChannelTargetIds(channel) {
	const commandSecretTargets = getCommandSecretTargets();
	if (!channel) return toTargetIdSet(commandSecretTargets.channels);
	return toTargetIdSet(commandSecretTargets.channels.filter((id) => id.startsWith(`channels.${channel}.`)));
}
function pathTargetsScopedChannelAccount(params) {
	const [root, channelId, accountRoot, accountId] = params.pathSegments;
	if (root !== "channels" || channelId !== params.channel) return false;
	if (accountRoot !== "accounts") return true;
	return accountId === params.accountId;
}
function getScopedChannelsCommandSecretTargets(params) {
	const channel = normalizeOptionalString(params.channel);
	const targetIds = selectChannelTargetIds(channel);
	const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
	if (!channel || !normalizedAccountId) return { targetIds };
	const allowedPaths = /* @__PURE__ */ new Set();
	for (const target of discoverConfigSecretTargetsByIds(params.config, targetIds)) if (pathTargetsScopedChannelAccount({
		pathSegments: target.pathSegments,
		channel,
		accountId: normalizedAccountId
	})) allowedPaths.add(target.path);
	return {
		targetIds,
		allowedPaths
	};
}
function getQrRemoteCommandSecretTargetIds() {
	return toTargetIdSet(STATIC_QR_REMOTE_TARGET_IDS);
}
function getChannelsCommandSecretTargetIds() {
	return toTargetIdSet(getCommandSecretTargets().channels);
}
function getConfiguredChannelsCommandSecretTargetIds(config, env) {
	return toTargetIdSet(getConfiguredChannelSecretTargetIds(config, env));
}
function getModelsCommandSecretTargetIds() {
	return toTargetIdSet(STATIC_MODEL_TARGET_IDS);
}
function getMemoryEmbeddingCommandSecretTargetIds() {
	return toTargetIdSet(STATIC_MEMORY_EMBEDDING_TARGET_IDS);
}
function getTtsCommandSecretTargetIds() {
	return toTargetIdSet(STATIC_TTS_TARGET_IDS);
}
function getAgentRuntimeCommandSecretTargetIds(params) {
	if (params?.includeChannelTargets !== true) return toTargetIdSet(getAgentRuntimeBaseTargetIds());
	return toTargetIdSet(getCommandSecretTargets().agentRuntime);
}
function getCapabilityWebFetchCommandSecretTargetIds() {
	return toTargetIdSet(getCapabilityWebFetchTargetIds());
}
function getCapabilityWebFetchCommandSecretTargets(config, options) {
	if (resolveFetchConfig(config)?.enabled === false) return { targetIds: getCapabilityWebFetchCommandSecretTargetIds() };
	const selectedProviderId = resolveSelectedWebFetchProviderId(config, options?.providerId);
	if (!selectedProviderId) return getCapabilityWebFetchAutoDetectTargets(config);
	const selectedTargets = getCapabilityWebFetchSelectedProviderTargetIds(config, selectedProviderId);
	if (!selectedTargets.matchedProvider && !options?.providerId) return getCapabilityWebFetchAutoDetectTargets(config);
	const targetIds = toTargetIdSet(selectedTargets.targetIds);
	const allowedPaths = selectedTargets.allowedPaths.length > 0 ? new Set(selectedTargets.targetPaths) : void 0;
	const forcedActivePaths = discoverForcedActivePaths(config, toTargetIdSet(options?.providerId ? selectedTargets.targetIds : selectedTargets.fallbackTargetIds), allowedPaths);
	return {
		targetIds,
		...allowedPaths ? { allowedPaths } : {},
		...forcedActivePaths ? { forcedActivePaths } : {}
	};
}
function getCapabilityWebSearchCommandSecretTargetIds() {
	return toTargetIdSet(getCapabilityWebSearchTargetIds());
}
function getCapabilityWebSearchCommandSecretTargets(config, options) {
	if (resolveSearchConfig(config)?.enabled === false) return { targetIds: getCapabilityWebSearchCommandSecretTargetIds() };
	const selectedProviderId = resolveSelectedWebSearchProviderId(config, options?.providerId);
	if (!selectedProviderId) return getCapabilityWebSearchAutoDetectTargets(config);
	const selectedTargets = getCapabilityWebSearchSelectedProviderTargetIds(config, selectedProviderId);
	if (!selectedTargets.matchedProvider && !options?.providerId) return getCapabilityWebSearchAutoDetectTargets(config);
	const targetIds = toTargetIdSet(selectedTargets.targetIds);
	const allowedPaths = selectedTargets.allowedPaths.length > 0 ? new Set(selectedTargets.targetPaths) : void 0;
	const forcedActivePaths = discoverForcedActivePaths(config, toTargetIdSet(options?.providerId ? selectedTargets.targetIds : selectedTargets.fallbackTargetIds), allowedPaths);
	return {
		targetIds,
		...allowedPaths ? { allowedPaths } : {},
		...forcedActivePaths ? { forcedActivePaths } : {}
	};
}
function getStatusCommandSecretTargetIds(config, env) {
	const channelTargetIds = config ? getConfiguredChannelSecretTargetIds(config, env) : getChannelSecretTargetIds();
	return toTargetIdSet([...STATIC_STATUS_TARGET_IDS, ...channelTargetIds]);
}
function getSecurityAuditCommandSecretTargetIds() {
	return toTargetIdSet(getCommandSecretTargets().securityAudit);
}
//#endregion
export { getCapabilityWebSearchCommandSecretTargets as a, getMemoryEmbeddingCommandSecretTargetIds as c, getScopedChannelsCommandSecretTargets as d, getSecurityAuditCommandSecretTargetIds as f, getCapabilityWebSearchCommandSecretTargetIds as i, getModelsCommandSecretTargetIds as l, getTtsCommandSecretTargetIds as m, getCapabilityWebFetchCommandSecretTargetIds as n, getChannelsCommandSecretTargetIds as o, getStatusCommandSecretTargetIds as p, getCapabilityWebFetchCommandSecretTargets as r, getConfiguredChannelsCommandSecretTargetIds as s, getAgentRuntimeCommandSecretTargetIds as t, getQrRemoteCommandSecretTargetIds as u };
