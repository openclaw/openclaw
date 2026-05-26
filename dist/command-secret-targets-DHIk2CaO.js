import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeOptionalAccountId } from "./account-id-CwBWagLE.js";
import { t as loadChannelSecretContractApi } from "./channel-contract-api-BC6EV3dX.js";
import { o as listSecretTargetRegistryEntries, r as discoverConfigSecretTargetsByIds } from "./target-registry-BBvvwcuS.js";
import { n as listReadOnlyChannelPluginsForConfig } from "./read-only--nr5YM31.js";
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
	"tools.web.search.apiKey"
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
let cachedCommandSecretTargets;
let cachedAgentRuntimeBaseTargetIds;
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
export { getQrRemoteCommandSecretTargetIds as a, getStatusCommandSecretTargetIds as c, getModelsCommandSecretTargetIds as i, getChannelsCommandSecretTargetIds as n, getScopedChannelsCommandSecretTargets as o, getConfiguredChannelsCommandSecretTargetIds as r, getSecurityAuditCommandSecretTargetIds as s, getAgentRuntimeCommandSecretTargetIds as t };
