import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { i as loadPluginMetadataSnapshot, n as isPluginMetadataSnapshotCompatible } from "./plugin-metadata-snapshot-C-_V3F5M.js";
import { l as resolveEffectivePluginActivationState, n as createPluginActivationSource, s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { t as isPluginEnabledByDefaultForPlatform } from "./default-enablement-CT7_t1ee.js";
import { S as createPluginRegistryIdNormalizer, n as loadPluginManifestRegistryForPluginRegistry, r as normalizePluginsConfigWithRegistry } from "./plugin-registry-CgH_ZSlH.js";
import { t as isSafeChannelEnvVarTriggerName } from "./channel-env-var-names-B9EI0cwg.js";
import { a as resolveManifestOwnerBasePolicyBlock, i as passesManifestOwnerBasePolicy, n as isActivatedManifestOwner, r as isBundledManifestOwner, t as hasExplicitManifestOwnerTrust } from "./manifest-owner-policy-DqV-lgQl.js";
import { t as collectConfiguredAgentHarnessRuntimes } from "./harness-runtimes-Da9K6qai.js";
import { a as listPotentialConfiguredChannelPresenceSignals, i as listPotentialConfiguredChannelIds, r as listExplicitlyDisabledChannelIdsForConfig, t as hasMeaningfulChannelConfig } from "./config-presence-DiJ4UoDg.js";
import { t as collectPluginConfigContractMatches } from "./config-contracts-B5dqnQwa.js";
import { t as resolveManifestActivationPluginIds } from "./activation-planner-Cd6anAX7.js";
import { G as resolveMemoryDreamingConfig, K as resolveMemoryDreamingPluginConfig, _ as DEFAULT_MEMORY_DREAMING_PLUGIN_ID, q as resolveMemoryDreamingPluginId } from "./dreaming-CxCxWYoC.js";
import { n as resolveEffectiveTtsConfig } from "./tts-config-WOpwhkHq.js";
//#region src/plugins/channel-presence-policy.ts
const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
function dedupeSortedPluginIds(values) {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
function normalizeChannelIds(channelIds) {
	return Array.from(new Set([...channelIds].map((channelId) => normalizeOptionalLowercaseString(channelId)).filter((channelId) => Boolean(channelId)))).toSorted((left, right) => left.localeCompare(right));
}
function hasNonEmptyEnvValue(env, key) {
	if (!isSafeChannelEnvVarTriggerName(key)) return false;
	const trimmed = key.trim();
	const value = env[trimmed] ?? env[trimmed.toUpperCase()];
	return typeof value === "string" && value.trim().length > 0;
}
function hasExplicitChannelConfig(params) {
	const channels = params.config.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return false;
	const entry = channels[params.channelId];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	const enabled = entry.enabled;
	if (enabled === false) return false;
	return enabled === true || hasMeaningfulChannelConfig(entry);
}
function listExplicitConfiguredChannelIdsForConfig(config) {
	const channels = config.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return [];
	return Object.keys(channels).filter((channelId) => !IGNORED_CHANNEL_CONFIG_KEYS.has(channelId) && hasExplicitChannelConfig({
		config,
		channelId
	})).toSorted((left, right) => left.localeCompare(right));
}
function recordDeclaresChannel(record, channelId) {
	const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? "";
	if (!normalizedChannelId) return false;
	return record.channels.some((ownedChannelId) => (normalizeOptionalLowercaseString(ownedChannelId) ?? "") === normalizedChannelId);
}
function listManifestEnvConfiguredChannelSignals(params) {
	const signals = [];
	const seen = /* @__PURE__ */ new Set();
	const trustConfig = params.activationSourceConfig ?? params.config;
	const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
	for (const record of params.records) {
		if (!isChannelPluginEligibleForScopedOwnership({
			plugin: record,
			normalizedConfig,
			rootConfig: trustConfig
		})) continue;
		for (const channelId of record.channels) {
			if (!(record.channelEnvVars?.[channelId] ?? []).some((envVar) => hasNonEmptyEnvValue(params.env, envVar))) continue;
			if (seen.has(channelId)) continue;
			seen.add(channelId);
			signals.push({
				channelId,
				source: "manifest-env"
			});
		}
	}
	return signals.toSorted((left, right) => left.channelId.localeCompare(right.channelId));
}
function normalizeActivationBlockedReason(reason) {
	switch (reason) {
		case "plugins disabled": return "plugins-disabled";
		case "blocked by denylist": return "blocked-by-denylist";
		case "disabled in config": return "plugin-disabled";
		case "not in allowlist": return "not-in-allowlist";
		case "workspace plugin (disabled by default)": return "workspace-disabled-by-default";
		case "bundled (disabled by default)": return "bundled-disabled-by-default";
		default: return "not-activated";
	}
}
function resolveBasePolicyBlockedReason(params) {
	return resolveManifestOwnerBasePolicyBlock(params);
}
function isChannelPluginEligibleForScopedOwnership(params) {
	const allowRestrictiveAllowlistBypass = params.channelId !== void 0 && isBundledManifestOwner(params.plugin) && hasExplicitChannelConfig({
		config: params.rootConfig,
		channelId: params.channelId
	});
	if (!passesManifestOwnerBasePolicy({
		plugin: params.plugin,
		normalizedConfig: params.normalizedConfig,
		allowRestrictiveAllowlistBypass
	})) return false;
	if (isBundledManifestOwner(params.plugin)) return true;
	if (params.plugin.origin === "global" || params.plugin.origin === "config") return hasExplicitManifestOwnerTrust({
		plugin: params.plugin,
		normalizedConfig: params.normalizedConfig
	});
	return isActivatedManifestOwner({
		plugin: params.plugin,
		normalizedConfig: params.normalizedConfig,
		rootConfig: params.rootConfig
	});
}
function evaluateEffectiveChannelPlugin(params) {
	const explicitBundledChannelConfig = isBundledManifestOwner(params.plugin) && hasExplicitChannelConfig({
		config: params.activationSource.rootConfig ?? params.config,
		channelId: params.channelId
	});
	const baseBlockedReason = resolveBasePolicyBlockedReason({
		plugin: params.plugin,
		normalizedConfig: params.normalizedConfig,
		allowRestrictiveAllowlistBypass: explicitBundledChannelConfig
	});
	if (baseBlockedReason) return {
		effective: false,
		pluginId: params.plugin.id,
		blockedReason: baseBlockedReason
	};
	if (!isBundledManifestOwner(params.plugin)) {
		if (params.plugin.origin === "global" || params.plugin.origin === "config") return hasExplicitManifestOwnerTrust({
			plugin: params.plugin,
			normalizedConfig: params.normalizedConfig
		}) ? {
			effective: true,
			pluginId: params.plugin.id
		} : {
			effective: false,
			pluginId: params.plugin.id,
			blockedReason: "untrusted-plugin"
		};
		return isActivatedManifestOwner({
			plugin: params.plugin,
			normalizedConfig: params.normalizedConfig,
			rootConfig: params.activationSource.rootConfig
		}) ? {
			effective: true,
			pluginId: params.plugin.id
		} : {
			effective: false,
			pluginId: params.plugin.id,
			blockedReason: "untrusted-plugin"
		};
	}
	if (explicitBundledChannelConfig) return {
		effective: true,
		pluginId: params.plugin.id
	};
	const activationState = resolveEffectivePluginActivationState({
		id: params.plugin.id,
		origin: params.plugin.origin,
		config: params.normalizedConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin),
		activationSource: params.activationSource
	});
	return activationState.enabled ? {
		effective: true,
		pluginId: params.plugin.id
	} : {
		effective: false,
		pluginId: params.plugin.id,
		blockedReason: normalizeActivationBlockedReason(activationState.reason)
	};
}
function addPolicySignal(entries, channelId, source) {
	const normalized = normalizeOptionalLowercaseString(channelId);
	if (!normalized) return;
	let sources = entries.get(normalized);
	if (!sources) {
		sources = /* @__PURE__ */ new Set();
		entries.set(normalized, sources);
	}
	sources.add(source);
}
function loadInstalledChannelManifestRecords(params) {
	return loadPluginManifestRegistryForPluginRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeDisabled: true
	}).plugins;
}
function resolveConfiguredChannelPresencePolicy(params) {
	const env = params.env ?? process.env;
	const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
	const records = params.manifestRecords ?? loadInstalledChannelManifestRecords({
		config: params.config,
		workspaceDir,
		env
	});
	const disabledChannelIds = new Set(listExplicitlyDisabledChannelIdsForConfig(params.config));
	const entrySources = /* @__PURE__ */ new Map();
	for (const channelId of listExplicitConfiguredChannelIdsForConfig(params.config)) addPolicySignal(entrySources, channelId, "explicit-config");
	for (const signal of listPotentialConfiguredChannelPresenceSignals(params.config, env, { includePersistedAuthState: params.includePersistedAuthState })) {
		if (signal.source === "config") continue;
		addPolicySignal(entrySources, signal.channelId, signal.source);
	}
	for (const signal of listManifestEnvConfiguredChannelSignals({
		records,
		config: params.config,
		activationSourceConfig: params.activationSourceConfig,
		env
	})) addPolicySignal(entrySources, signal.channelId, signal.source);
	for (const channelId of disabledChannelIds) entrySources.delete(channelId);
	const activationSource = createPluginActivationSource({ config: params.activationSourceConfig ?? params.config });
	const normalizedConfig = activationSource.plugins;
	const entries = [];
	for (const channelId of normalizeChannelIds(entrySources.keys())) {
		const owningRecords = records.filter((record) => recordDeclaresChannel(record, channelId));
		const evaluations = owningRecords.map((plugin) => evaluateEffectiveChannelPlugin({
			plugin,
			channelId,
			normalizedConfig,
			config: params.config,
			activationSource
		}));
		const effectivePluginIds = evaluations.filter((entry) => entry.effective).map((entry) => entry.pluginId);
		const blockedReasons = owningRecords.length === 0 ? ["no-channel-owner"] : [...new Set(evaluations.map((entry) => entry.blockedReason).filter((reason) => Boolean(reason)))].toSorted((left, right) => left.localeCompare(right));
		entries.push({
			channelId,
			sources: [...entrySources.get(channelId) ?? []].toSorted((left, right) => left.localeCompare(right)),
			effective: effectivePluginIds.length > 0,
			pluginIds: dedupeSortedPluginIds(effectivePluginIds),
			blockedReasons
		});
	}
	return entries;
}
function listConfiguredChannelIdsForReadOnlyScope(params) {
	return resolveConfiguredChannelPresencePolicy(params).filter((entry) => entry.effective).map((entry) => entry.channelId);
}
function hasConfiguredChannelsForReadOnlyScope(params) {
	return listConfiguredChannelIdsForReadOnlyScope(params).length > 0;
}
function listConfiguredAnnounceChannelIdsForConfig(params) {
	const disabledChannelIds = new Set(listExplicitlyDisabledChannelIdsForConfig(params.config));
	return normalizeChannelIds([...listExplicitConfiguredChannelIdsForConfig(params.config), ...listConfiguredChannelIdsForReadOnlyScope({
		config: params.config,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includePersistedAuthState: false
	})]).filter((channelId) => !disabledChannelIds.has(channelId));
}
function resolveScopedChannelOwnerPluginIds(params) {
	const channelIds = normalizeChannelIds(params.channelIds);
	if (channelIds.length === 0) return [];
	const records = params.manifestRecords ?? loadInstalledChannelManifestRecords({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	});
	const trustConfig = params.activationSourceConfig ?? params.config;
	const normalizedConfig = normalizePluginsConfig(trustConfig.plugins);
	const candidateIds = dedupeSortedPluginIds(channelIds.flatMap((channelId) => {
		return resolveManifestActivationPluginIds({
			trigger: {
				kind: "channel",
				channel: channelId
			},
			config: params.config,
			workspaceDir: params.workspaceDir,
			env: params.env,
			manifestRecords: records,
			allowRestrictiveAllowlistBypass: hasExplicitChannelConfig({
				config: trustConfig,
				channelId
			})
		});
	}));
	if (candidateIds.length === 0) return [];
	const candidateIdSet = new Set(candidateIds);
	return records.filter((plugin) => {
		if (!candidateIdSet.has(plugin.id)) return false;
		return isChannelPluginEligibleForScopedOwnership({
			plugin,
			normalizedConfig,
			rootConfig: trustConfig,
			channelId: channelIds.find((channelId) => recordDeclaresChannel(plugin, channelId))
		});
	}).map((plugin) => plugin.id).toSorted((left, right) => left.localeCompare(right));
}
function resolveDiscoverableScopedChannelPluginIds(params) {
	return resolveScopedChannelOwnerPluginIds(params);
}
function resolveConfiguredChannelPluginIds(params) {
	const configuredChannelIds = normalizeChannelIds([...listConfiguredChannelIdsForReadOnlyScope({
		config: params.config,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		env: params.env
	}), ...listExplicitConfiguredChannelIdsForConfig(params.activationSourceConfig ?? params.config)]);
	if (configuredChannelIds.length === 0) return [];
	return resolveScopedChannelOwnerPluginIds({
		...params,
		channelIds: configuredChannelIds
	});
}
//#endregion
//#region src/plugins/gateway-startup-speech-providers.ts
const TTS_PROVIDER_CONFIG_RESERVED_KEYS = new Set([
	"auto",
	"enabled",
	"maxTextLength",
	"mode",
	"modelOverrides",
	"persona",
	"personas",
	"prefsPath",
	"provider",
	"providers",
	"summaryModel",
	"timeoutMs"
]);
function isRecord$1(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isConfigActivationValueEnabled$1(value) {
	if (value === false) return false;
	if (isRecord$1(value) && value.enabled === false) return false;
	return true;
}
function normalizeConfiguredSpeechProviderIdForStartup(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
	return normalized === "edge" ? "microsoft" : normalized;
}
function resolveProviderConfigActivation(ttsConfig, providerId) {
	let fromProviders;
	if (isRecord$1(ttsConfig.providers)) {
		for (const [key, providerConfig] of Object.entries(ttsConfig.providers)) if (normalizeConfiguredSpeechProviderIdForStartup(key) === providerId) fromProviders = isConfigActivationValueEnabled$1(providerConfig);
	}
	if (fromProviders !== void 0) return fromProviders;
	for (const [key, providerConfig] of Object.entries(ttsConfig)) {
		if (TTS_PROVIDER_CONFIG_RESERVED_KEYS.has(key) || !isRecord$1(providerConfig)) continue;
		if (normalizeConfiguredSpeechProviderIdForStartup(key) === providerId) return isConfigActivationValueEnabled$1(providerConfig);
	}
}
function addProviderIfEnabled(target, ttsConfig, providerId) {
	const normalized = normalizeConfiguredSpeechProviderIdForStartup(providerId);
	if (!normalized) return;
	if (resolveProviderConfigActivation(ttsConfig, normalized) !== false) target.add(normalized);
}
function findActivePersona(ttsConfig) {
	const personaId = normalizeOptionalLowercaseString(typeof ttsConfig.persona === "string" ? ttsConfig.persona : void 0);
	if (!personaId || !isRecord$1(ttsConfig.personas)) return;
	for (const [id, persona] of Object.entries(ttsConfig.personas)) if (normalizeOptionalLowercaseString(id) === personaId && isRecord$1(persona)) return persona;
}
function addActivePersonaProvider(target, ttsConfig) {
	const persona = findActivePersona(ttsConfig);
	if (!persona) return;
	const provider = normalizeConfiguredSpeechProviderIdForStartup(persona.provider);
	if (!provider) return;
	const rootActivation = resolveProviderConfigActivation(ttsConfig, provider);
	if ((resolveProviderConfigActivation(persona, provider) ?? rootActivation) !== false) target.add(provider);
}
function addConfiguredTtsProviderIds(target, value) {
	if (!isRecord$1(value)) return;
	addProviderIfEnabled(target, value, value.provider);
	addActivePersonaProvider(target, value);
	if (isRecord$1(value.providers)) {
		for (const [providerId, providerConfig] of Object.entries(value.providers)) if (isConfigActivationValueEnabled$1(providerConfig)) addProviderIfEnabled(target, value, providerId);
	}
	for (const [key, providerConfig] of Object.entries(value)) {
		if (TTS_PROVIDER_CONFIG_RESERVED_KEYS.has(key) || !isRecord$1(providerConfig)) continue;
		if (isConfigActivationValueEnabled$1(providerConfig)) addProviderIfEnabled(target, value, key);
	}
}
function collectConfiguredSpeechProviderIds(config) {
	const configured = /* @__PURE__ */ new Set();
	addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config));
	const agents = config.agents;
	if (isRecord$1(agents) && Array.isArray(agents.list)) {
		for (const agent of agents.list) if (isRecord$1(agent)) if (typeof agent.id === "string") addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config, { agentId: agent.id }));
		else addConfiguredTtsProviderIds(configured, agent.tts);
	}
	const channels = config.channels;
	if (isRecord$1(channels)) for (const [channelId, channelConfig] of Object.entries(channels)) {
		if (!isRecord$1(channelConfig)) continue;
		addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config, { channelId }));
		if (isRecord$1(channelConfig.voice)) addConfiguredTtsProviderIds(configured, channelConfig.voice.tts);
		if (isRecord$1(channelConfig.accounts)) for (const [accountId, accountConfig] of Object.entries(channelConfig.accounts)) {
			if (!isRecord$1(accountConfig)) continue;
			addConfiguredTtsProviderIds(configured, resolveEffectiveTtsConfig(config, {
				channelId,
				accountId
			}));
			if (isRecord$1(accountConfig.voice)) addConfiguredTtsProviderIds(configured, accountConfig.voice.tts);
		}
	}
	const pluginEntries = config.plugins?.entries;
	if (isRecord$1(pluginEntries)) {
		for (const entry of Object.values(pluginEntries)) if (isRecord$1(entry) && isRecord$1(entry.config)) addConfiguredTtsProviderIds(configured, entry.config.tts);
	}
	return configured;
}
//#endregion
//#region src/plugins/gateway-startup-plugin-ids.ts
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isConfigActivationValueEnabled(value) {
	if (value === false) return false;
	if (isRecord(value) && value.enabled === false) return false;
	return true;
}
function listPotentialEnabledChannelIds(config, env) {
	const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(config));
	return listPotentialConfiguredChannelIds(config, env, { includePersistedAuthState: false }).map((id) => normalizeOptionalLowercaseString(id) ?? "").filter((id) => id && !disabled.has(id));
}
function isGatewayStartupMemoryPlugin(plugin) {
	return plugin.startup.memory;
}
function resolveGatewayStartupDreamingPluginIds(config) {
	if (!resolveMemoryDreamingConfig({
		pluginConfig: resolveMemoryDreamingPluginConfig(config),
		cfg: config
	}).enabled) return /* @__PURE__ */ new Set();
	return new Set([DEFAULT_MEMORY_DREAMING_PLUGIN_ID, resolveMemoryDreamingPluginId(config)]);
}
function resolveMemorySlotStartupPluginId(params) {
	const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
	const configuredSlot = activationSourceConfig.plugins?.slots?.memory?.trim();
	if (configuredSlot?.toLowerCase() === "none") return;
	if (!configuredSlot) {
		const defaultSlot = activationSourcePlugins.slots.memory;
		if (typeof defaultSlot !== "string") return;
		if (activationSourcePlugins.allow.length > 0 && !activationSourcePlugins.allow.includes(defaultSlot)) return;
		return defaultSlot;
	}
	return normalizePluginId(configuredSlot);
}
function resolveContextEngineSlotStartupPluginId(params) {
	const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
	const configuredSlot = activationSourceConfig.plugins?.slots?.contextEngine?.trim();
	if (!configuredSlot) return;
	const normalized = normalizePluginId(configuredSlot);
	if (normalized === "legacy") return;
	if (activationSourcePlugins.deny.includes(normalized)) return;
	if (activationSourcePlugins.entries[normalized]?.enabled === false) return;
	return normalized;
}
function shouldConsiderForGatewayStartup(params) {
	if (params.manifest?.activation?.onStartup === true) return true;
	if (params.contextEngineSlotStartupPluginId === params.plugin.pluginId) return true;
	if (!isGatewayStartupMemoryPlugin(params.plugin)) return false;
	if (params.startupDreamingPluginIds.has(params.plugin.pluginId)) return true;
	return params.memorySlotStartupPluginId === params.plugin.pluginId;
}
function hasConfiguredStartupChannel(params) {
	return listManifestChannelIds(params.manifestLookup, params.plugin.pluginId).some((channelId) => params.configuredChannelIds.has(channelId));
}
function createManifestRegistryLookup(manifestRegistry) {
	return new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
}
function listManifestChannelIds(manifestLookup, pluginId) {
	return manifestLookup.get(pluginId)?.channels ?? [];
}
function findManifestPlugin(manifestLookup, pluginId) {
	return manifestLookup.get(pluginId);
}
function hasConfiguredActivationPath(params) {
	const paths = params.manifest?.activation?.onConfigPaths;
	if (!paths?.length) return false;
	return paths.some((pathPattern) => collectPluginConfigContractMatches({
		root: params.config,
		pathPattern
	}).some((match) => isConfigActivationValueEnabled(match.value)));
}
function manifestOwnsConfiguredSpeechProvider(params) {
	if (params.configuredSpeechProviderIds.size === 0) return false;
	return (params.manifest?.contracts?.speechProviders ?? []).some((providerId) => {
		const normalized = normalizeConfiguredSpeechProviderIdForStartup(providerId);
		return normalized ? params.configuredSpeechProviderIds.has(normalized) : false;
	});
}
function collectConfiguredWebSearchProviderIds(config) {
	const search = config.tools?.web?.search;
	if (search?.enabled === false || typeof search?.provider !== "string") return /* @__PURE__ */ new Set();
	const providerId = normalizeOptionalLowercaseString(search.provider);
	return providerId ? new Set([providerId]) : /* @__PURE__ */ new Set();
}
function manifestOwnsConfiguredWebSearchProvider(params) {
	if (params.configuredWebSearchProviderIds.size === 0) return false;
	return (params.manifest?.contracts?.webSearchProviders ?? []).some((providerId) => {
		const normalized = normalizeOptionalLowercaseString(providerId);
		return normalized ? params.configuredWebSearchProviderIds.has(normalized) : false;
	});
}
function listModelProviderRefs(value) {
	if (typeof value === "string") return [value];
	if (!isRecord(value)) return [];
	const refs = [];
	if (typeof value.primary === "string") refs.push(value.primary);
	if (Array.isArray(value.fallbacks)) {
		for (const fallback of value.fallbacks) if (typeof fallback === "string") refs.push(fallback);
	}
	return refs;
}
function collectModelProviderIds(value) {
	return new Set(listModelProviderRefs(value).map((ref) => {
		const slashIndex = ref.indexOf("/");
		return slashIndex > 0 ? normalizeOptionalLowercaseString(ref.slice(0, slashIndex)) : "";
	}).filter((providerId) => Boolean(providerId)));
}
function collectConfiguredGenerationProviderIds(config) {
	const defaults = config.agents?.defaults;
	return {
		imageGenerationProviders: collectModelProviderIds(defaults?.imageGenerationModel),
		videoGenerationProviders: collectModelProviderIds(defaults?.videoGenerationModel),
		musicGenerationProviders: collectModelProviderIds(defaults?.musicGenerationModel)
	};
}
function manifestOwnsConfiguredGenerationProvider(params) {
	for (const contractKey of [
		"imageGenerationProviders",
		"videoGenerationProviders",
		"musicGenerationProviders"
	]) {
		const configuredProviderIds = params.configuredGenerationProviderIds[contractKey];
		if (configuredProviderIds.size === 0) continue;
		if ((params.manifest?.contracts?.[contractKey] ?? []).some((providerId) => {
			const normalized = normalizeOptionalLowercaseString(providerId);
			return normalized ? configuredProviderIds.has(normalized) : false;
		})) return true;
	}
	return false;
}
function canStartConfiguredGenerationProviderPlugin(params) {
	if (!manifestOwnsConfiguredGenerationProvider({
		manifest: params.manifest,
		configuredGenerationProviderIds: params.configuredGenerationProviderIds
	})) return false;
	if (!params.pluginsConfig.enabled || !params.activationSource.plugins.enabled) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId) || params.activationSource.plugins.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false || params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false) return false;
	const activationState = resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.pluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
		activationSource: params.activationSource
	});
	return activationState.enabled && (params.plugin.origin === "bundled" || activationState.explicitlyEnabled);
}
function canStartRequiredAgentHarnessPlugin(params) {
	if (!params.plugin.startup.agentHarnesses.some((runtime) => params.requiredAgentHarnessRuntimes.has(runtime))) return false;
	if (!params.pluginsConfig.enabled || !params.activationSource.plugins.enabled) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId) || params.activationSource.plugins.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false || params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false) return false;
	if (params.pluginsConfig.allow.length > 0 && !params.pluginsConfig.allow.includes(params.plugin.pluginId)) return false;
	if (params.activationSource.plugins.allow.length > 0 && !params.activationSource.plugins.allow.includes(params.plugin.pluginId)) return false;
	return resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.pluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
		activationSource: params.activationSource
	}).enabled || params.plugin.origin === "bundled";
}
function canStartConfiguredSpeechProviderPlugin(params) {
	if (!manifestOwnsConfiguredSpeechProvider({
		manifest: params.manifest,
		configuredSpeechProviderIds: params.configuredSpeechProviderIds
	})) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId) || params.activationSource.plugins.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false || params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false) return false;
	if (params.plugin.origin === "bundled") return true;
	const activationState = resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.pluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
		activationSource: params.activationSource
	});
	return activationState.enabled && activationState.explicitlyEnabled;
}
function canStartConfiguredWebSearchProviderPlugin(params) {
	if (!manifestOwnsConfiguredWebSearchProvider({
		manifest: params.manifest,
		configuredWebSearchProviderIds: params.configuredWebSearchProviderIds
	})) return false;
	if (!params.pluginsConfig.enabled || !params.activationSource.plugins.enabled) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId) || params.activationSource.plugins.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false || params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false) return false;
	return resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.pluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
		activationSource: params.activationSource
	}).enabled;
}
function canStartConfiguredRootPlugin(params) {
	if (params.plugin.origin !== "bundled") return false;
	if (!hasConfiguredActivationPath({
		manifest: params.manifest,
		config: params.config
	})) return false;
	if (!params.pluginsConfig.enabled || !params.activationSourcePlugins.enabled) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId) || params.activationSourcePlugins.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false || params.activationSourcePlugins.entries[params.plugin.pluginId]?.enabled === false) return false;
	return true;
}
function hasExplicitHookPolicyConfig(entry) {
	return entry?.hooks?.allowConversationAccess === true || entry?.hooks?.allowPromptInjection === true || entry?.hooks?.timeoutMs !== void 0 || entry?.hooks?.timeouts !== void 0 && Object.keys(entry.hooks.timeouts).length > 0;
}
function hasHookRuntimeStartupIntent(params) {
	if (params.manifest?.activation?.onCapabilities?.includes("hook")) return true;
	return hasExplicitHookPolicyConfig(params.activationSourcePlugins.entries[params.plugin.pluginId]);
}
function canStartExplicitHookPlugin(params) {
	const hasHookPolicyIntent = hasExplicitHookPolicyConfig(params.activationSourcePlugins.entries[params.plugin.pluginId]);
	if (!hasHookRuntimeStartupIntent({
		plugin: params.plugin,
		manifest: params.manifest,
		activationSourcePlugins: params.activationSourcePlugins
	})) return false;
	if (!params.pluginsConfig.enabled || !params.activationSourcePlugins.enabled) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId) || params.activationSourcePlugins.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false || params.activationSourcePlugins.entries[params.plugin.pluginId]?.enabled === false) return false;
	const activationState = resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.pluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
		activationSource: params.activationSource
	});
	return activationState.enabled && (activationState.explicitlyEnabled || hasHookPolicyIntent);
}
function canStartConfiguredChannelPlugin(params) {
	if (!params.pluginsConfig.enabled) return false;
	if (params.pluginsConfig.deny.includes(params.plugin.pluginId)) return false;
	if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false) return false;
	const explicitBundledChannelConfig = params.plugin.origin === "bundled" && listManifestChannelIds(params.manifestLookup, params.plugin.pluginId).some((channelId) => hasExplicitChannelConfig({
		config: params.activationSource.rootConfig ?? params.config,
		channelId
	}));
	if (params.pluginsConfig.allow.length > 0 && !params.pluginsConfig.allow.includes(params.plugin.pluginId) && !explicitBundledChannelConfig) return false;
	if (params.plugin.origin === "bundled") return true;
	const activationState = resolveEffectivePluginActivationState({
		id: params.plugin.pluginId,
		origin: params.plugin.origin,
		config: params.pluginsConfig,
		rootConfig: params.config,
		enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
		activationSource: params.activationSource
	});
	return activationState.enabled && activationState.explicitlyEnabled;
}
function resolveChannelPluginIds(params) {
	return [...loadGatewayStartupPluginPlan(params).channelPluginIds];
}
function resolveChannelPluginIdsFromRegistry(params) {
	const { manifestRegistry } = params;
	return manifestRegistry.plugins.filter((plugin) => plugin.channels.length > 0).map((plugin) => plugin.id);
}
function resolveConfiguredDeferredChannelPluginIdsFromRegistry(params) {
	const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
	if (configuredChannelIds.size === 0) return [];
	const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, params.index, { manifestRegistry: params.manifestRegistry });
	const activationSource = {
		plugins: pluginsConfig,
		rootConfig: params.config
	};
	const manifestLookup = createManifestRegistryLookup(params.manifestRegistry);
	return params.index.plugins.filter((plugin) => hasConfiguredStartupChannel({
		plugin,
		manifestLookup,
		configuredChannelIds
	}) && plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen && canStartConfiguredChannelPlugin({
		plugin,
		config: params.config,
		pluginsConfig,
		activationSource,
		manifestLookup
	})).map((plugin) => plugin.pluginId);
}
function resolveConfiguredDeferredChannelPluginIds(params) {
	return [...loadGatewayStartupPluginPlan(params).configuredDeferredChannelPluginIds];
}
function resolveGatewayStartupPluginPlanFromRegistry(params) {
	const channelPluginIds = resolveChannelPluginIdsFromRegistry({ manifestRegistry: params.manifestRegistry });
	const configuredDeferredChannelPluginIds = resolveConfiguredDeferredChannelPluginIdsFromRegistry({
		config: params.config,
		env: params.env,
		index: params.index,
		manifestRegistry: params.manifestRegistry
	});
	const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
	const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, params.index, { manifestRegistry: params.manifestRegistry });
	const activationSourceConfig = params.activationSourceConfig ?? params.config;
	const activationSourcePlugins = normalizePluginsConfigWithRegistry(activationSourceConfig.plugins, params.index, { manifestRegistry: params.manifestRegistry });
	const activationSource = {
		plugins: activationSourcePlugins,
		rootConfig: activationSourceConfig
	};
	const requiredAgentHarnessRuntimes = new Set(collectConfiguredAgentHarnessRuntimes(activationSourceConfig, params.env, {
		includeEnvRuntime: false,
		includeLegacyAgentRuntimes: false
	}));
	const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
	const manifestLookup = createManifestRegistryLookup(params.manifestRegistry);
	const configuredSpeechProviderIds = collectConfiguredSpeechProviderIds(activationSourceConfig);
	const configuredWebSearchProviderIds = collectConfiguredWebSearchProviderIds(activationSourceConfig);
	const configuredGenerationProviderIds = collectConfiguredGenerationProviderIds(activationSourceConfig);
	const normalizePluginId = createPluginRegistryIdNormalizer(params.index, { manifestRegistry: params.manifestRegistry });
	const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
		activationSourceConfig,
		activationSourcePlugins,
		normalizePluginId
	});
	const contextEngineSlotStartupPluginId = resolveContextEngineSlotStartupPluginId({
		activationSourceConfig,
		activationSourcePlugins,
		normalizePluginId
	});
	return {
		channelPluginIds,
		configuredDeferredChannelPluginIds,
		pluginIds: params.index.plugins.filter((plugin) => {
			const manifest = findManifestPlugin(manifestLookup, plugin.pluginId);
			if (hasConfiguredStartupChannel({
				plugin,
				manifestLookup,
				configuredChannelIds
			})) return canStartConfiguredChannelPlugin({
				plugin,
				config: params.config,
				pluginsConfig,
				activationSource,
				manifestLookup,
				platform: params.platform
			});
			if (canStartRequiredAgentHarnessPlugin({
				plugin,
				pluginsConfig,
				activationSource,
				config: params.config,
				requiredAgentHarnessRuntimes,
				platform: params.platform
			})) return true;
			if (canStartConfiguredRootPlugin({
				plugin,
				manifest,
				config: activationSourceConfig,
				pluginsConfig,
				activationSourcePlugins
			})) return true;
			if (canStartConfiguredSpeechProviderPlugin({
				plugin,
				manifest,
				config: params.config,
				pluginsConfig,
				activationSource,
				configuredSpeechProviderIds,
				platform: params.platform
			})) return true;
			if (canStartConfiguredWebSearchProviderPlugin({
				plugin,
				manifest,
				config: params.config,
				pluginsConfig,
				activationSource,
				configuredWebSearchProviderIds,
				platform: params.platform
			})) return true;
			if (canStartConfiguredGenerationProviderPlugin({
				plugin,
				manifest,
				config: params.config,
				pluginsConfig,
				activationSource,
				configuredGenerationProviderIds,
				platform: params.platform
			})) return true;
			if (canStartExplicitHookPlugin({
				plugin,
				manifest,
				config: params.config,
				pluginsConfig,
				activationSource,
				activationSourcePlugins,
				platform: params.platform
			})) return true;
			if (!shouldConsiderForGatewayStartup({
				plugin,
				manifest,
				startupDreamingPluginIds,
				memorySlotStartupPluginId,
				contextEngineSlotStartupPluginId
			})) return false;
			const activationState = resolveEffectivePluginActivationState({
				id: plugin.pluginId,
				origin: plugin.origin,
				config: pluginsConfig,
				rootConfig: params.config,
				enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin, params.platform),
				activationSource
			});
			if (!activationState.enabled) return false;
			if (plugin.origin !== "bundled") return activationState.explicitlyEnabled;
			return activationState.source === "explicit" || activationState.source === "default";
		}).map((plugin) => plugin.pluginId)
	};
}
function resolveGatewayStartupPluginIdsFromRegistry(params) {
	return [...resolveGatewayStartupPluginPlanFromRegistry(params).pluginIds];
}
function loadGatewayStartupPluginPlan(params) {
	const snapshotConfig = params.activationSourceConfig ?? params.config;
	const metadataSnapshot = params.metadataSnapshot && isPluginMetadataSnapshotCompatible({
		snapshot: params.metadataSnapshot,
		config: snapshotConfig,
		env: params.env,
		workspaceDir: params.workspaceDir,
		index: params.index
	}) ? params.metadataSnapshot : loadPluginMetadataSnapshot({
		config: snapshotConfig,
		workspaceDir: params.workspaceDir,
		env: params.env,
		...params.index ? { index: params.index } : {}
	});
	return resolveGatewayStartupPluginPlanFromRegistry({
		config: params.config,
		...params.activationSourceConfig !== void 0 ? { activationSourceConfig: params.activationSourceConfig } : {},
		env: params.env,
		index: metadataSnapshot.index,
		manifestRegistry: metadataSnapshot.manifestRegistry,
		platform: params.platform
	});
}
function resolveGatewayStartupPluginIds(params) {
	return [...loadGatewayStartupPluginPlan(params).pluginIds];
}
//#endregion
export { resolveConfiguredDeferredChannelPluginIdsFromRegistry as a, resolveGatewayStartupPluginPlanFromRegistry as c, listConfiguredAnnounceChannelIdsForConfig as d, listConfiguredChannelIdsForReadOnlyScope as f, resolveDiscoverableScopedChannelPluginIds as g, resolveConfiguredChannelPresencePolicy as h, resolveConfiguredDeferredChannelPluginIds as i, hasConfiguredChannelsForReadOnlyScope as l, resolveConfiguredChannelPluginIds as m, resolveChannelPluginIds as n, resolveGatewayStartupPluginIds as o, listExplicitConfiguredChannelIdsForConfig as p, resolveChannelPluginIdsFromRegistry as r, resolveGatewayStartupPluginIdsFromRegistry as s, loadGatewayStartupPluginPlan as t, hasExplicitChannelConfig as u };
