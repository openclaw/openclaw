import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeOptionalAccountId } from "./account-id-9_btbLFO.js";
import { i as resolveManifestContractOwnerPluginId } from "./plugin-registry-ClNEONMJ.js";
import { t as loadChannelSecretContractApi } from "./channel-contract-api-NhrwfwUG.js";
import { o as listSecretTargetRegistryEntries, r as discoverConfigSecretTargetsByIds } from "./target-registry-BFJgB0Tb.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only-Cf7CPR2F.js";
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
const STATIC_WEB_SEARCH_TARGET_IDS = ["tools.web.search.apiKey"];
const STATIC_WEB_FETCH_TARGET_IDS = ["tools.web.fetch.firecrawl.apiKey"];
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
let cachedCommandSecretTargets;
let cachedAgentRuntimeBaseTargetIds;
let cachedChannelSecretTargetIds;
function getChannelSecretTargetIds() {
	cachedChannelSecretTargetIds ??= idsByPrefix(["channels."]);
	return cachedChannelSecretTargetIds;
}
function isPluginWebCredentialTargetId(id, configPathFilter) {
	const segments = id.split(".");
	if (segments[0] !== "plugins" || segments[1] !== "entries" || segments[3] !== "config") return false;
	const configPath = segments.slice(4).join(".");
	if (configPathFilter) return configPath === configPathFilter;
	return configPath === "webSearch.apiKey" || configPath === "webFetch.apiKey";
}
function getPluginWebCredentialTargetIds(configPath) {
	return listSecretTargetRegistryEntries().map((entry) => entry.id).filter((id) => isPluginWebCredentialTargetId(id, configPath)).toSorted();
}
function pluginIdFromWebCredentialPath(path, configPath) {
	const match = /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(path);
	if (!match) return;
	return match[2] === configPath.split(".")[0] ? match[1] : void 0;
}
function getAgentRuntimeBaseTargetIds() {
	cachedAgentRuntimeBaseTargetIds ??= [...STATIC_AGENT_RUNTIME_BASE_TARGET_IDS, ...listSecretTargetRegistryEntries().map((entry) => entry.id).filter((id) => isPluginWebCredentialTargetId(id)).toSorted()];
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
function mergeTargetIdSets(...sets) {
	const merged = /* @__PURE__ */ new Set();
	for (const set of sets) for (const value of set) merged.add(value);
	return merged;
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
function getWebSearchCommandSecretTargetIds() {
	return toTargetIdSet([...STATIC_WEB_SEARCH_TARGET_IDS, ...getPluginWebCredentialTargetIds("webSearch.apiKey")]);
}
function getWebFetchCommandSecretTargetIds() {
	return toTargetIdSet([...STATIC_WEB_FETCH_TARGET_IDS, ...getPluginWebCredentialTargetIds("webFetch.apiKey")]);
}
function getConfiguredWebProviderId(config, kind) {
	const webConfig = config.tools?.web?.[kind];
	return normalizeOptionalLowercaseString(webConfig && typeof webConfig === "object" ? webConfig.provider : void 0);
}
function configuredTargetPaths(config, targetIds) {
	return new Set(discoverConfigSecretTargetsByIds(config, targetIds).map((target) => target.path));
}
function modelProviderCredentialFallbackPathForWebSearchProvider(providerId) {
	switch (providerId) {
		case "gemini": return "models.providers.google.apiKey";
		case "ollama": return "models.providers.ollama.apiKey";
		default: return;
	}
}
function resolveSelectedWebProviderPluginId(params) {
	if (!params.providerId) return;
	return resolveManifestContractOwnerPluginId({
		config: params.config,
		contract: params.contract,
		value: params.providerId
	}) ?? params.providerId;
}
function pathForPluginCredential(paths, pluginId, configPath) {
	if (!pluginId) return;
	for (const path of paths) if (pluginIdFromWebCredentialPath(path, configPath) === pluginId) return path;
}
function getWebSearchCommandSecretTargets(params) {
	const webSearchTargetIds = getWebSearchCommandSecretTargetIds();
	const targetIds = new Set(webSearchTargetIds);
	const providerId = normalizeOptionalLowercaseString(params.provider) ?? getConfiguredWebProviderId(params.config, "search");
	const webSearchPaths = configuredTargetPaths(params.config, webSearchTargetIds);
	if (!providerId) return {
		targetIds,
		allowedPaths: webSearchPaths
	};
	const allowedPaths = /* @__PURE__ */ new Set();
	const pluginCredentialPath = pathForPluginCredential(webSearchPaths, resolveSelectedWebProviderPluginId({
		config: params.config,
		providerId,
		contract: "webSearchProviders"
	}), "webSearch.apiKey");
	if (pluginCredentialPath) {
		allowedPaths.add(pluginCredentialPath);
		return {
			targetIds,
			allowedPaths
		};
	}
	const fallbackPath = modelProviderCredentialFallbackPathForWebSearchProvider(providerId);
	if (fallbackPath) {
		if (configuredTargetPaths(params.config, getModelsCommandSecretTargetIds()).has(fallbackPath)) {
			targetIds.add("models.providers.*.apiKey");
			allowedPaths.add(fallbackPath);
			return {
				targetIds,
				allowedPaths
			};
		}
	}
	if (webSearchPaths.has("tools.web.search.apiKey")) allowedPaths.add("tools.web.search.apiKey");
	return {
		targetIds,
		allowedPaths
	};
}
function getWebFetchCommandSecretTargets(params) {
	const webFetchTargetIds = getWebFetchCommandSecretTargetIds();
	const webSearchTargetIds = getWebSearchCommandSecretTargetIds();
	const webFetchPaths = configuredTargetPaths(params.config, webFetchTargetIds);
	const webSearchPaths = configuredTargetPaths(params.config, webSearchTargetIds);
	const providerId = normalizeOptionalLowercaseString(params.provider) ?? getConfiguredWebProviderId(params.config, "fetch");
	const selectedPluginId = resolveSelectedWebProviderPluginId({
		config: params.config,
		providerId,
		contract: "webFetchProviders"
	});
	const webFetchPluginIds = new Set([...getPluginWebCredentialTargetIds("webFetch.apiKey")].map((id) => pluginIdFromWebCredentialPath(id, "webFetch.apiKey")).filter((id) => Boolean(id)));
	const candidatePluginIds = /* @__PURE__ */ new Set();
	if (selectedPluginId) candidatePluginIds.add(selectedPluginId);
	for (const path of webFetchPaths) {
		const pluginId = pluginIdFromWebCredentialPath(path, "webFetch.apiKey");
		if (!selectedPluginId && pluginId) candidatePluginIds.add(pluginId);
	}
	for (const path of webSearchPaths) {
		const pluginId = pluginIdFromWebCredentialPath(path, "webSearch.apiKey");
		if (!selectedPluginId && pluginId && webFetchPluginIds.has(pluginId)) candidatePluginIds.add(pluginId);
	}
	const allowedPaths = /* @__PURE__ */ new Set();
	const pluginsWithFetchCredential = /* @__PURE__ */ new Set();
	let hasWebSearchFallbackPath = false;
	for (const path of webFetchPaths) {
		const pluginId = pluginIdFromWebCredentialPath(path, "webFetch.apiKey");
		if (!selectedPluginId || pluginId && candidatePluginIds.has(pluginId)) {
			allowedPaths.add(path);
			if (pluginId) pluginsWithFetchCredential.add(pluginId);
		}
	}
	if (webFetchPaths.has("tools.web.fetch.firecrawl.apiKey") && (!selectedPluginId || selectedPluginId === "firecrawl" || providerId === "firecrawl")) allowedPaths.add("tools.web.fetch.firecrawl.apiKey");
	for (const path of webSearchPaths) {
		const pluginId = pluginIdFromWebCredentialPath(path, "webSearch.apiKey");
		if (pluginId && candidatePluginIds.has(pluginId) && !pluginsWithFetchCredential.has(pluginId)) {
			allowedPaths.add(path);
			hasWebSearchFallbackPath = true;
		}
	}
	return {
		targetIds: hasWebSearchFallbackPath ? mergeTargetIdSets(webFetchTargetIds, webSearchTargetIds) : new Set(webFetchTargetIds),
		allowedPaths
	};
}
function getAgentRuntimeCommandSecretTargetIds(params) {
	if (params?.includeChannelTargets !== true) return toTargetIdSet(getAgentRuntimeBaseTargetIds());
	return toTargetIdSet(getCommandSecretTargets().agentRuntime);
}
function getStatusCommandSecretTargetIds(config, env) {
	const channelTargetIds = config ? getConfiguredChannelSecretTargetIds(config, env) : getChannelSecretTargetIds();
	return toTargetIdSet([...STATIC_STATUS_TARGET_IDS, ...channelTargetIds]);
}
function getSecurityAuditCommandSecretTargetIds() {
	return toTargetIdSet(getCommandSecretTargets().securityAudit);
}
//#endregion
export { getModelsCommandSecretTargetIds as a, getSecurityAuditCommandSecretTargetIds as c, getWebFetchCommandSecretTargetIds as d, getWebFetchCommandSecretTargets as f, getMemoryEmbeddingCommandSecretTargetIds as i, getStatusCommandSecretTargetIds as l, getWebSearchCommandSecretTargets as m, getChannelsCommandSecretTargetIds as n, getQrRemoteCommandSecretTargetIds as o, getWebSearchCommandSecretTargetIds as p, getConfiguredChannelsCommandSecretTargetIds as r, getScopedChannelsCommandSecretTargets as s, getAgentRuntimeCommandSecretTargetIds as t, getTtsCommandSecretTargetIds as u };
