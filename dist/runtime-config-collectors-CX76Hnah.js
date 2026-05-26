import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { s as normalizePluginsConfig, u as resolveEnableState } from "./config-state-CjJBf8PG.js";
import { t as loadChannelSecretContractApi } from "./channel-contract-api-BKyJzTiE.js";
import "./shared-Cv5g0_Ch.js";
import { n as getBootstrapChannelSecrets } from "./bootstrap-registry-W87CNNcz.js";
import { n as resolvePluginConfigContractsById, t as collectPluginConfigContractMatches } from "./config-contracts-B5dqnQwa.js";
import { r as resolvePluginCapabilityProviders } from "./capability-provider-runtime-BwiWIvn0.js";
import { n as normalizeMediaProviderId } from "./provider-id-BETgOIvU.js";
import { t as resolveImageCapableConfigProviderIds } from "./config-provider-models-DbsyMOsr.js";
import { n as resolveConfiguredMediaEntryCapabilities, r as resolveEffectiveMediaEntryCapabilities } from "./entry-capabilities-DGvNSGdr.js";
import { n as collectSecretInputAssignment } from "./runtime-shared-CPFXAPqc.js";
import { t as collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts-Bm58-KHt.js";
import { n as evaluateGatewayAuthSurfaceStates } from "./runtime-gateway-auth-surfaces-C7es4SNw.js";
//#region src/secrets/runtime-config-collectors-channels.ts
function collectChannelConfigAssignments(params) {
	const channelIds = Object.keys(params.config.channels ?? {});
	if (channelIds.length === 0) return;
	for (const channelId of channelIds) (loadChannelSecretContractApi({
		channelId,
		config: params.config,
		env: params.context.env,
		loadablePluginOrigins: params.loadablePluginOrigins
	})?.collectRuntimeConfigAssignments ?? getBootstrapChannelSecrets(channelId)?.collectRuntimeConfigAssignments)?.(params);
}
//#endregion
//#region src/media-understanding/provider-capability-registry.ts
function mergeProviderCapabilities(registry, provider) {
	const normalizedKey = normalizeMediaProviderId(provider.id);
	const existing = registry.get(normalizedKey);
	registry.set(normalizedKey, { capabilities: provider.capabilities ?? existing?.capabilities });
}
function buildMediaUnderstandingCapabilityRegistry(cfg) {
	const registry = /* @__PURE__ */ new Map();
	for (const provider of resolvePluginCapabilityProviders({
		key: "mediaUnderstandingProviders",
		cfg
	})) mergeProviderCapabilities(registry, provider);
	for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg)) if (!registry.has(normalizedKey)) mergeProviderCapabilities(registry, {
		id: normalizedKey,
		capabilities: ["image"]
	});
	return registry;
}
//#endregion
//#region src/secrets/runtime-config-collectors-core.ts
function collectModelProviderAssignments(params) {
	for (const [providerId, provider] of Object.entries(params.providers)) {
		const providerIsActive = provider.enabled !== false;
		collectSecretInputAssignment({
			value: provider.apiKey,
			path: `models.providers.${providerId}.apiKey`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: providerIsActive,
			inactiveReason: "provider is disabled.",
			apply: (value) => {
				provider.apiKey = value;
			}
		});
		const headers = isRecord(provider.headers) ? provider.headers : void 0;
		if (headers) for (const [headerKey, headerValue] of Object.entries(headers)) collectSecretInputAssignment({
			value: headerValue,
			path: `models.providers.${providerId}.headers.${headerKey}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: providerIsActive,
			inactiveReason: "provider is disabled.",
			apply: (value) => {
				headers[headerKey] = value;
			}
		});
		const request = isRecord(provider.request) ? provider.request : void 0;
		if (request) collectProviderRequestAssignments({
			request,
			pathPrefix: `models.providers.${providerId}.request`,
			defaults: params.defaults,
			context: params.context,
			active: providerIsActive,
			inactiveReason: "provider is disabled.",
			collectTransportSecrets: true
		});
	}
}
function collectSkillAssignments(params) {
	for (const [skillKey, entry] of Object.entries(params.entries)) collectSecretInputAssignment({
		value: entry.apiKey,
		path: `skills.entries.${skillKey}.apiKey`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: entry.enabled !== false,
		inactiveReason: "skill entry is disabled.",
		apply: (value) => {
			entry.apiKey = value;
		}
	});
}
function collectAgentMemorySearchAssignments(params) {
	const agents = params.config.agents;
	if (!isRecord(agents)) return;
	const defaultsConfig = isRecord(agents.defaults) ? agents.defaults : void 0;
	const defaultsMemorySearch = isRecord(defaultsConfig?.memorySearch) ? defaultsConfig.memorySearch : void 0;
	const defaultsEnabled = defaultsMemorySearch?.enabled !== false;
	const list = Array.isArray(agents.list) ? agents.list : [];
	let hasEnabledAgentWithoutOverride = false;
	for (const rawAgent of list) {
		if (!isRecord(rawAgent)) continue;
		if (rawAgent.enabled === false) continue;
		const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : void 0;
		if (memorySearch?.enabled === false) continue;
		if (!memorySearch || !Object.prototype.hasOwnProperty.call(memorySearch, "remote")) {
			hasEnabledAgentWithoutOverride = true;
			continue;
		}
		const remote = isRecord(memorySearch.remote) ? memorySearch.remote : void 0;
		if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) {
			hasEnabledAgentWithoutOverride = true;
			continue;
		}
	}
	if (defaultsMemorySearch && isRecord(defaultsMemorySearch.remote)) {
		const remote = defaultsMemorySearch.remote;
		collectSecretInputAssignment({
			value: remote.apiKey,
			path: "agents.defaults.memorySearch.remote.apiKey",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: defaultsEnabled && (hasEnabledAgentWithoutOverride || list.length === 0),
			inactiveReason: hasEnabledAgentWithoutOverride ? void 0 : "all enabled agents override memorySearch.remote.apiKey.",
			apply: (value) => {
				remote.apiKey = value;
			}
		});
	}
	list.forEach((rawAgent, index) => {
		if (!isRecord(rawAgent)) return;
		const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : void 0;
		if (!memorySearch) return;
		const remote = isRecord(memorySearch.remote) ? memorySearch.remote : void 0;
		if (!remote || !Object.prototype.hasOwnProperty.call(remote, "apiKey")) return;
		const enabled = rawAgent.enabled !== false && memorySearch.enabled !== false;
		collectSecretInputAssignment({
			value: remote.apiKey,
			path: `agents.list.${index}.memorySearch.remote.apiKey`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: enabled,
			inactiveReason: "agent or memorySearch override is disabled.",
			apply: (value) => {
				remote.apiKey = value;
			}
		});
	});
}
function collectTalkAssignments(params) {
	const talk = params.config.talk;
	if (!isRecord(talk)) return;
	collectSecretInputAssignment({
		value: talk.apiKey,
		path: "talk.apiKey",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		apply: (value) => {
			talk.apiKey = value;
		}
	});
	const providers = talk.providers;
	if (!isRecord(providers)) return;
	for (const [providerId, providerConfig] of Object.entries(providers)) {
		if (!isRecord(providerConfig)) continue;
		collectSecretInputAssignment({
			value: providerConfig.apiKey,
			path: `talk.providers.${providerId}.apiKey`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			apply: (value) => {
				providerConfig.apiKey = value;
			}
		});
	}
}
function collectGatewayAssignments(params) {
	const gateway = params.config.gateway;
	if (!isRecord(gateway)) return;
	const auth = isRecord(gateway.auth) ? gateway.auth : void 0;
	const remote = isRecord(gateway.remote) ? gateway.remote : void 0;
	const gatewaySurfaceStates = evaluateGatewayAuthSurfaceStates({
		config: params.config,
		env: params.context.env,
		defaults: params.defaults
	});
	if (auth) {
		collectSecretInputAssignment({
			value: auth.token,
			path: "gateway.auth.token",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.auth.token"].active,
			inactiveReason: gatewaySurfaceStates["gateway.auth.token"].reason,
			apply: (value) => {
				auth.token = value;
			}
		});
		collectSecretInputAssignment({
			value: auth.password,
			path: "gateway.auth.password",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.auth.password"].active,
			inactiveReason: gatewaySurfaceStates["gateway.auth.password"].reason,
			apply: (value) => {
				auth.password = value;
			}
		});
	}
	if (remote) {
		collectSecretInputAssignment({
			value: remote.token,
			path: "gateway.remote.token",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.remote.token"].active,
			inactiveReason: gatewaySurfaceStates["gateway.remote.token"].reason,
			apply: (value) => {
				remote.token = value;
			}
		});
		collectSecretInputAssignment({
			value: remote.password,
			path: "gateway.remote.password",
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: gatewaySurfaceStates["gateway.remote.password"].active,
			inactiveReason: gatewaySurfaceStates["gateway.remote.password"].reason,
			apply: (value) => {
				remote.password = value;
			}
		});
	}
}
function collectProviderRequestAssignments(params) {
	const headers = isRecord(params.request.headers) ? params.request.headers : void 0;
	if (headers) for (const [headerKey, headerValue] of Object.entries(headers)) collectSecretInputAssignment({
		value: headerValue,
		path: `${params.pathPrefix}.headers.${headerKey}`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: params.active,
		inactiveReason: params.inactiveReason,
		apply: (value) => {
			headers[headerKey] = value;
		}
	});
	const auth = isRecord(params.request.auth) ? params.request.auth : void 0;
	if (auth) {
		collectSecretInputAssignment({
			value: auth.token,
			path: `${params.pathPrefix}.auth.token`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: params.active,
			inactiveReason: params.inactiveReason,
			apply: (value) => {
				auth.token = value;
			}
		});
		collectSecretInputAssignment({
			value: auth.value,
			path: `${params.pathPrefix}.auth.value`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: params.active,
			inactiveReason: params.inactiveReason,
			apply: (value) => {
				auth.value = value;
			}
		});
	}
	const collectTlsAssignments = (tls, pathPrefix) => {
		if (!tls) return;
		for (const key of [
			"ca",
			"cert",
			"key",
			"passphrase"
		]) collectSecretInputAssignment({
			value: tls[key],
			path: `${pathPrefix}.${key}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active: params.active,
			inactiveReason: params.inactiveReason,
			apply: (value) => {
				tls[key] = value;
			}
		});
	};
	if (params.collectTransportSecrets !== false) {
		collectTlsAssignments(isRecord(params.request.tls) ? params.request.tls : void 0, `${params.pathPrefix}.tls`);
		const proxy = isRecord(params.request.proxy) ? params.request.proxy : void 0;
		collectTlsAssignments(isRecord(proxy?.tls) ? proxy.tls : void 0, `${params.pathPrefix}.proxy.tls`);
	}
}
function collectMediaRequestAssignments(params) {
	const tools = isRecord(params.config.tools) ? params.config.tools : void 0;
	const media = isRecord(tools?.media) ? tools.media : void 0;
	if (!media) return;
	let providerRegistry;
	const getProviderRegistry = () => {
		providerRegistry ??= buildMediaUnderstandingCapabilityRegistry(params.config);
		return providerRegistry;
	};
	const capabilityKeys = [
		"audio",
		"image",
		"video"
	];
	const isCapabilityEnabled = (capability) => (isRecord(media[capability]) ? media[capability] : void 0)?.enabled !== false;
	const collectModelAssignments = (models, pathPrefix, resolveActivity) => {
		if (!Array.isArray(models)) return;
		models.forEach((rawModel, index) => {
			if (!isRecord(rawModel) || !isRecord(rawModel.request)) return;
			const { active, inactiveReason } = resolveActivity(rawModel);
			collectProviderRequestAssignments({
				request: rawModel.request,
				pathPrefix: `${pathPrefix}.${index}.request`,
				defaults: params.defaults,
				context: params.context,
				active,
				inactiveReason
			});
		});
	};
	collectModelAssignments(media.models, "tools.media.models", (rawModel) => {
		const entry = rawModel;
		const capabilities = resolveConfiguredMediaEntryCapabilities(entry) ?? resolveEffectiveMediaEntryCapabilities({
			entry,
			source: "shared",
			providerRegistry: getProviderRegistry()
		});
		if (!capabilities || capabilities.length === 0) return {
			active: false,
			inactiveReason: "shared media model does not declare capabilities and none could be inferred from its provider."
		};
		return {
			active: capabilities.some((capability) => isCapabilityEnabled(capability)),
			inactiveReason: `all configured media capabilities for this shared model are disabled: ${capabilities.join(", ")}.`
		};
	});
	for (const capability of capabilityKeys) {
		const section = isRecord(media[capability]) ? media[capability] : void 0;
		const active = isCapabilityEnabled(capability);
		const inactiveReason = `${capability} media understanding is disabled.`;
		if (section && isRecord(section.request)) collectProviderRequestAssignments({
			request: section.request,
			pathPrefix: `tools.media.${capability}.request`,
			defaults: params.defaults,
			context: params.context,
			active,
			inactiveReason
		});
		collectModelAssignments(section?.models, `tools.media.${capability}.models`, (rawModel) => ({
			active: active && (() => {
				const configuredCapabilities = resolveConfiguredMediaEntryCapabilities(rawModel);
				return configuredCapabilities ? configuredCapabilities.includes(capability) : true;
			})(),
			inactiveReason: active ? `${capability} media model is filtered out by its configured capabilities.` : inactiveReason
		}));
	}
}
function collectMessagesTtsAssignments(params) {
	const messages = params.config.messages;
	if (!isRecord(messages) || !isRecord(messages.tts)) return;
	collectTtsApiKeyAssignments({
		tts: messages.tts,
		pathPrefix: "messages.tts",
		defaults: params.defaults,
		context: params.context
	});
}
function collectAgentTtsAssignments(params) {
	const list = params.config.agents?.list;
	if (!Array.isArray(list)) return;
	for (const [index, entry] of list.entries()) {
		if (!isRecord(entry) || !isRecord(entry.tts)) continue;
		collectTtsApiKeyAssignments({
			tts: entry.tts,
			pathPrefix: `agents.list.${index}.tts`,
			defaults: params.defaults,
			context: params.context
		});
	}
}
function collectCronAssignments(params) {
	const cron = params.config.cron;
	if (!isRecord(cron)) return;
	collectSecretInputAssignment({
		value: cron.webhookToken,
		path: "cron.webhookToken",
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		apply: (value) => {
			cron.webhookToken = value;
		}
	});
}
function collectSandboxSshAssignments(params) {
	const agents = isRecord(params.config.agents) ? params.config.agents : void 0;
	if (!agents) return;
	const defaultsAgent = isRecord(agents.defaults) ? agents.defaults : void 0;
	const defaultsSandbox = isRecord(defaultsAgent?.sandbox) ? defaultsAgent.sandbox : void 0;
	const defaultsSsh = isRecord(defaultsSandbox?.ssh) ? defaultsSandbox.ssh : void 0;
	const defaultsBackend = typeof defaultsSandbox?.backend === "string" ? defaultsSandbox.backend : void 0;
	const defaultsMode = typeof defaultsSandbox?.mode === "string" ? defaultsSandbox.mode : void 0;
	const inheritedDefaultsUsage = {
		identityData: false,
		certificateData: false,
		knownHostsData: false
	};
	(Array.isArray(agents.list) ? agents.list : []).forEach((rawAgent, index) => {
		const agentRecord = isRecord(rawAgent) ? rawAgent : null;
		if (!agentRecord || agentRecord.enabled === false) return;
		const sandbox = isRecord(agentRecord.sandbox) ? agentRecord.sandbox : void 0;
		const ssh = isRecord(sandbox?.ssh) ? sandbox.ssh : void 0;
		const effectiveBackend = (typeof sandbox?.backend === "string" ? sandbox.backend : void 0) ?? defaultsBackend ?? "docker";
		const effectiveMode = (typeof sandbox?.mode === "string" ? sandbox.mode : void 0) ?? defaultsMode ?? "off";
		const active = normalizeOptionalLowercaseString(effectiveBackend) === "ssh" && effectiveMode !== "off";
		for (const key of [
			"identityData",
			"certificateData",
			"knownHostsData"
		]) if (ssh && Object.prototype.hasOwnProperty.call(ssh, key)) collectSecretInputAssignment({
			value: ssh[key],
			path: `agents.list.${index}.sandbox.ssh.${key}`,
			expected: "string",
			defaults: params.defaults,
			context: params.context,
			active,
			inactiveReason: "sandbox SSH backend is not active for this agent.",
			apply: (value) => {
				ssh[key] = value;
			}
		});
		else if (active) inheritedDefaultsUsage[key] = true;
	});
	if (!defaultsSsh) return;
	const defaultsActive = normalizeOptionalLowercaseString(defaultsBackend) === "ssh" && defaultsMode !== "off" || inheritedDefaultsUsage.identityData || inheritedDefaultsUsage.certificateData || inheritedDefaultsUsage.knownHostsData;
	for (const key of [
		"identityData",
		"certificateData",
		"knownHostsData"
	]) collectSecretInputAssignment({
		value: defaultsSsh[key],
		path: `agents.defaults.sandbox.ssh.${key}`,
		expected: "string",
		defaults: params.defaults,
		context: params.context,
		active: defaultsActive || inheritedDefaultsUsage[key],
		inactiveReason: "sandbox SSH backend is not active.",
		apply: (value) => {
			defaultsSsh[key] = value;
		}
	});
}
function collectCoreConfigAssignments(params) {
	const providers = params.config.models?.providers;
	if (providers) collectModelProviderAssignments({
		providers,
		defaults: params.defaults,
		context: params.context
	});
	const skillEntries = params.config.skills?.entries;
	if (skillEntries) collectSkillAssignments({
		entries: skillEntries,
		defaults: params.defaults,
		context: params.context
	});
	collectAgentMemorySearchAssignments(params);
	collectTalkAssignments(params);
	collectGatewayAssignments(params);
	collectSandboxSshAssignments(params);
	collectMessagesTtsAssignments(params);
	collectAgentTtsAssignments(params);
	collectCronAssignments(params);
	collectMediaRequestAssignments(params);
}
//#endregion
//#region src/secrets/runtime-config-collectors-plugins.ts
/**
* Walk manifest-declared plugin config SecretRef surfaces and collect
* assignments for runtime materialization. Plugin-owned metadata controls which
* config paths support SecretRefs and whether bundled plugins stay inactive on
* that surface until explicitly enabled.
*
* When `loadablePluginOrigins` is provided, entries whose ID is not in the map
* are treated as inactive (stale config entries for plugins that are no longer
* installed). This prevents resolution failures for SecretRefs belonging to
* non-loadable plugins from blocking startup or preflight validation.
*/
function collectPluginConfigAssignments(params) {
	const entries = params.config.plugins?.entries;
	if (!isRecord(entries)) return;
	const normalizedConfig = normalizePluginsConfig(params.config.plugins);
	const workspaceDir = resolveAgentWorkspaceDir(params.config, resolveDefaultAgentId(params.config));
	const bundledLoadablePluginIds = [...params.loadablePluginOrigins?.entries() ?? []].filter(([, origin]) => origin === "bundled").map(([pluginId]) => pluginId);
	const pluginSecretInputs = new Map([...resolvePluginConfigContractsById({
		config: params.config,
		workspaceDir,
		env: params.context.env,
		fallbackToBundledMetadata: true,
		fallbackToBundledMetadataForResolvedBundled: true,
		fallbackBundledPluginIds: bundledLoadablePluginIds,
		pluginIds: Object.keys(entries)
	}).entries()].flatMap(([pluginId, metadata]) => {
		const secretInputs = metadata.configContracts.secretInputs;
		if (!secretInputs?.paths.length) return [];
		return [[pluginId, {
			origin: metadata.origin,
			bundledDefaultEnabled: secretInputs.bundledDefaultEnabled,
			paths: secretInputs.paths
		}]];
	}));
	for (const [pluginId, entry] of Object.entries(entries)) {
		const secretInputs = pluginSecretInputs.get(pluginId);
		if (!secretInputs) continue;
		if (!isRecord(entry)) continue;
		const pluginConfig = entry.config;
		if (!isRecord(pluginConfig)) continue;
		const pluginOrigin = params.loadablePluginOrigins?.get(pluginId);
		if (params.loadablePluginOrigins && !pluginOrigin) {
			collectConfiguredPluginSecretAssignments({
				pluginId,
				pluginConfig,
				secretPaths: secretInputs.paths,
				active: false,
				inactiveReason: "plugin is not loadable (stale config entry).",
				defaults: params.defaults,
				context: params.context
			});
			continue;
		}
		const resolvedOrigin = pluginOrigin ?? secretInputs.origin;
		const enableState = resolveEnableState(pluginId, resolvedOrigin, normalizedConfig, resolvedOrigin === "bundled" ? secretInputs.bundledDefaultEnabled : void 0);
		collectConfiguredPluginSecretAssignments({
			pluginId,
			pluginConfig,
			secretPaths: secretInputs.paths,
			active: enableState.enabled,
			inactiveReason: enableState.reason ?? "plugin is disabled.",
			defaults: params.defaults,
			context: params.context
		});
	}
}
function collectConfiguredPluginSecretAssignments(params) {
	const seenPaths = /* @__PURE__ */ new Set();
	for (const secretPath of params.secretPaths) for (const match of collectPluginConfigContractMatches({
		root: params.pluginConfig,
		pathPattern: secretPath.path
	})) {
		const fullPath = `plugins.entries.${params.pluginId}.config.${match.path}`;
		if (seenPaths.has(fullPath)) continue;
		seenPaths.add(fullPath);
		collectSecretInputAssignment({
			value: match.value,
			path: fullPath,
			expected: secretPath.expected ?? "string",
			defaults: params.defaults,
			context: params.context,
			active: params.active,
			inactiveReason: `plugin "${params.pluginId}": ${params.inactiveReason}`,
			apply: createPluginConfigAssignmentApply(params.pluginConfig, match.path)
		});
	}
}
function createPluginConfigAssignmentApply(pluginConfig, relativePath) {
	return (value) => {
		const segments = relativePath.replace(/\[(\d+)\]/g, ".$1").split(".").map((segment) => segment.trim()).filter(Boolean);
		if (segments.length === 0) return;
		let current = pluginConfig;
		for (const segment of segments.slice(0, -1)) {
			if (Array.isArray(current)) {
				const index = Number.parseInt(segment, 10);
				current = Number.isInteger(index) ? current[index] : void 0;
				continue;
			}
			current = isRecord(current) ? current[segment] : void 0;
		}
		const finalSegment = segments.at(-1);
		if (!finalSegment) return;
		if (Array.isArray(current)) {
			const index = Number.parseInt(finalSegment, 10);
			if (Number.isInteger(index) && index >= 0 && index < current.length) current[index] = value;
			return;
		}
		if (isRecord(current)) current[finalSegment] = value;
	};
}
//#endregion
//#region src/secrets/runtime-config-collectors.ts
function collectConfigAssignments(params) {
	const defaults = params.context.sourceConfig.secrets?.defaults;
	collectCoreConfigAssignments({
		config: params.config,
		defaults,
		context: params.context
	});
	collectChannelConfigAssignments({
		config: params.config,
		defaults,
		context: params.context,
		loadablePluginOrigins: params.loadablePluginOrigins
	});
	collectPluginConfigAssignments({
		config: params.config,
		defaults,
		context: params.context,
		loadablePluginOrigins: params.loadablePluginOrigins
	});
}
//#endregion
export { collectConfigAssignments as t };
