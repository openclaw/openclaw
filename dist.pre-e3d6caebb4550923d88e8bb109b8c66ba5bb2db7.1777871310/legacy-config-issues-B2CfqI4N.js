import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { n as DEFAULT_GATEWAY_PORT } from "./paths-C1_Y0cDn.js";
import { c as isRecord } from "./utils-CCskKJVV.js";
import { n as getCachedPluginModuleLoader, t as createPluginModuleLoaderCache } from "./plugin-module-loader-cache-AdUe8-Mp.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-KP09XqO0.js";
import { t as isBlockedObjectKey } from "./prototype-keys-RBElZn9Q.js";
import { n as loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry-DiJTylvG.js";
import { t as isSafeExecutableValue } from "./exec-safety-Bm3doKZA.js";
import { s as loadManifestMetadataSnapshot } from "./manifest-contract-eligibility-DWkPvc9L.js";
import { t as getBootstrapChannelPlugin } from "./bootstrap-registry-kKk9J215.js";
import { n as asNullableRecord } from "./record-coerce-B3XP6JAO.js";
import { i as resolveOpenClawMcpTransportAlias, n as isKnownCliMcpTypeAlias } from "./mcp-config-normalize-DKuo7uP-.js";
import { a as resolveGatewayPortWithDefault, i as isGatewayNonLoopbackBindMode, r as hasConfiguredControlUiAllowedOrigins, t as buildDefaultControlUiAllowedOrigins } from "./gateway-control-ui-origins-05HmjaGA.js";
import { n as ensureRecord$2, r as hasOwnKey$1, t as cloneRecord$1 } from "./legacy-config-record-shared-ZXAICtAn.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
//#region src/plugins/doctor-contract-registry.ts
const CONTRACT_API_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".cts"
];
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) || CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const moduleLoaders = createPluginModuleLoaderCache();
function loadPluginDoctorContractModule(modulePath) {
	return getCachedPluginModuleLoader({
		cache: moduleLoaders,
		modulePath,
		importerUrl: import.meta.url
	})(modulePath);
}
function resolveContractApiPath(rootDir) {
	const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT ? CONTRACT_API_EXTENSIONS : [...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)];
	for (const extension of orderedExtensions) {
		const candidate = path.join(rootDir, `doctor-contract-api${extension}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	for (const extension of orderedExtensions) {
		const candidate = path.join(rootDir, `contract-api${extension}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}
function coerceLegacyConfigRules(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const candidate = entry;
		return Array.isArray(candidate.path) && typeof candidate.message === "string";
	});
}
function coerceNormalizeCompatibilityConfig(value) {
	return typeof value === "function" ? value : void 0;
}
function hasLegacyElevenLabsTalkFields(raw) {
	const talk = asNullableRecord(asNullableRecord(raw)?.talk);
	if (!talk) return false;
	return [
		"voiceId",
		"voiceAliases",
		"modelId",
		"outputFormat",
		"apiKey"
	].some((key) => Object.prototype.hasOwnProperty.call(talk, key));
}
function collectRelevantDoctorPluginIds(raw) {
	const ids = /* @__PURE__ */ new Set();
	const root = asNullableRecord(raw);
	if (!root) return [];
	const channels = asNullableRecord(root.channels);
	if (channels) {
		for (const channelId of Object.keys(channels)) if (channelId !== "defaults") ids.add(channelId);
	}
	const pluginsEntries = asNullableRecord(asNullableRecord(root.plugins)?.entries);
	if (pluginsEntries) for (const pluginId of Object.keys(pluginsEntries)) ids.add(pluginId);
	if (hasLegacyElevenLabsTalkFields(root)) ids.add("elevenlabs");
	return [...ids].toSorted();
}
function collectRelevantDoctorPluginIdsForTouchedPaths(params) {
	const root = asNullableRecord(params.raw);
	if (!root) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const touchedPath of params.touchedPaths) {
		const [first, second, third] = touchedPath;
		if (first === "channels") {
			if (!second) return collectRelevantDoctorPluginIds(params.raw);
			if (second !== "defaults") ids.add(second);
			continue;
		}
		if (first === "plugins") {
			if (second !== "entries" || !third) return collectRelevantDoctorPluginIds(params.raw);
			ids.add(third);
			continue;
		}
		if (first === "talk" && hasLegacyElevenLabsTalkFields(root)) ids.add("elevenlabs");
	}
	return [...ids].toSorted();
}
function loadPluginDoctorContractEntry(record) {
	const contractSource = resolveContractApiPath(record.rootDir);
	if (!contractSource) return null;
	let mod;
	try {
		mod = loadPluginDoctorContractModule(contractSource);
	} catch {
		return null;
	}
	const rules = coerceLegacyConfigRules(mod.default?.legacyConfigRules ?? mod.legacyConfigRules);
	const normalizeCompatibilityConfig = coerceNormalizeCompatibilityConfig(mod.normalizeCompatibilityConfig ?? mod.default?.normalizeCompatibilityConfig);
	if (rules.length === 0 && !normalizeCompatibilityConfig) return null;
	return {
		pluginId: record.id,
		rules,
		normalizeCompatibilityConfig
	};
}
function resolvePluginDoctorContracts(params) {
	const env = params?.env ?? process.env;
	if (params?.pluginIds && params.pluginIds.length === 0) return [];
	const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
		workspaceDir: params?.workspaceDir,
		env,
		includeDisabled: true
	});
	const entries = [];
	const scopedPluginIds = params?.pluginIds ? new Set(params.pluginIds) : null;
	for (const record of manifestRegistry.plugins) {
		if (scopedPluginIds && !scopedPluginIds.has(record.id) && !record.channels.some((channelId) => scopedPluginIds.has(channelId)) && !record.providers.some((providerId) => scopedPluginIds.has(providerId))) continue;
		const entry = loadPluginDoctorContractEntry(record);
		if (entry) entries.push(entry);
	}
	return entries;
}
function listPluginDoctorLegacyConfigRules(params) {
	return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}
function applyPluginDoctorCompatibilityMigrations(cfg, params) {
	let nextCfg = cfg;
	const changes = [];
	for (const entry of resolvePluginDoctorContracts(params)) {
		const mutation = entry.normalizeCompatibilityConfig?.({ cfg: nextCfg });
		if (!mutation || mutation.changes.length === 0) continue;
		nextCfg = mutation.config;
		changes.push(...mutation.changes);
	}
	return {
		config: nextCfg,
		changes
	};
}
//#endregion
//#region src/channels/plugins/doctor-contract-api.ts
function loadBundledChannelPublicArtifact(channelId, artifactBasenames) {
	for (const artifactBasename of artifactBasenames) try {
		return loadBundledPluginPublicArtifactModuleSync({
			dirName: channelId,
			artifactBasename
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unable to resolve bundled plugin public surface ")) continue;
	}
}
function loadBundledChannelDoctorContractApi(channelId) {
	return loadBundledChannelPublicArtifact(channelId, ["doctor-contract-api.js", "contract-api.js"]);
}
//#endregion
//#region src/channels/plugins/legacy-config.ts
function collectConfiguredChannelIds$1(raw) {
	if (!raw || typeof raw !== "object") return [];
	const channels = raw.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return [];
	return Object.keys(channels).filter((channelId) => channelId !== "defaults").map((channelId) => channelId);
}
function shouldIncludeLegacyRuleForTouchedPaths(rulePath, touchedPaths) {
	if (!touchedPaths || touchedPaths.length === 0) return true;
	return touchedPaths.some((touchedPath) => {
		const sharedLength = Math.min(rulePath.length, touchedPath.length);
		for (let index = 0; index < sharedLength; index += 1) if (rulePath[index] !== touchedPath[index]) return false;
		return true;
	});
}
function collectRelevantChannelIdsForTouchedPaths(params) {
	const channelIds = collectConfiguredChannelIds$1(params.raw);
	const filteredChannelIds = params.excludedChannelIds?.size ? channelIds.filter((channelId) => !params.excludedChannelIds?.has(channelId)) : channelIds;
	if (!params.touchedPaths || params.touchedPaths.length === 0) return filteredChannelIds;
	const touchedChannelIds = /* @__PURE__ */ new Set();
	for (const touchedPath of params.touchedPaths) {
		const [first, second] = touchedPath;
		if (first !== "channels") continue;
		if (!second) return filteredChannelIds;
		if (second === "defaults") continue;
		touchedChannelIds.add(second);
	}
	if (touchedChannelIds.size === 0) return [];
	return filteredChannelIds.filter((channelId) => touchedChannelIds.has(channelId));
}
function collectChannelLegacyConfigRules(raw, touchedPaths, excludedChannelIds) {
	const channelIds = collectRelevantChannelIdsForTouchedPaths({
		raw,
		touchedPaths,
		excludedChannelIds
	});
	const rules = [];
	const unresolvedChannelIds = [];
	for (const channelId of channelIds) {
		const contractRules = loadBundledChannelDoctorContractApi(channelId)?.legacyConfigRules;
		if (Array.isArray(contractRules)) {
			rules.push(...contractRules);
			continue;
		}
		const plugin = getBootstrapChannelPlugin(channelId);
		if (plugin?.doctor?.legacyConfigRules?.length) {
			rules.push(...plugin.doctor.legacyConfigRules);
			continue;
		}
		if (plugin) continue;
		unresolvedChannelIds.push(channelId);
	}
	if (unresolvedChannelIds.length > 0) rules.push(...listPluginDoctorLegacyConfigRules({ pluginIds: unresolvedChannelIds }));
	const seen = /* @__PURE__ */ new Set();
	return rules.filter((rule) => {
		if (!shouldIncludeLegacyRuleForTouchedPaths(rule.path, touchedPaths)) return false;
		const key = `${rule.path.join(".")}::${rule.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
//#endregion
//#region src/config/legacy.shared.ts
const getRecord = (value) => isRecord(value) ? value : null;
const ensureRecord$1 = (root, key) => {
	const existing = root[key];
	if (isRecord(existing)) return existing;
	const next = {};
	root[key] = next;
	return next;
};
const mergeMissing = (target, source) => {
	for (const [key, value] of Object.entries(source)) {
		if (value === void 0 || isBlockedObjectKey(key)) continue;
		const existing = target[key];
		if (existing === void 0) {
			target[key] = value;
			continue;
		}
		if (isRecord(existing) && isRecord(value)) mergeMissing(existing, value);
	}
};
const mapLegacyAudioTranscription = (value) => {
	const transcriber = getRecord(value);
	const command = Array.isArray(transcriber?.command) ? transcriber?.command : null;
	if (!command || command.length === 0) return null;
	if (typeof command[0] !== "string") return null;
	if (!command.every((part) => typeof part === "string")) return null;
	const rawExecutable = command[0].trim();
	if (!rawExecutable) return null;
	if (!isSafeExecutableValue(rawExecutable)) return null;
	const args = command.slice(1).map((part) => part.replace(/\{input\}/g, "{{MediaPath}}"));
	const timeoutSeconds = typeof transcriber?.timeoutSeconds === "number" ? transcriber?.timeoutSeconds : void 0;
	const result = {
		command: rawExecutable,
		type: "cli"
	};
	if (args.length > 0) result.args = args;
	if (timeoutSeconds !== void 0) result.timeoutSeconds = timeoutSeconds;
	return result;
};
const defineLegacyConfigMigration = (migration) => migration;
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.audio.ts
function applyLegacyAudioTranscriptionModel(params) {
	const mapped = mapLegacyAudioTranscription(params.source);
	if (!mapped) {
		params.changes.push(params.invalidMessage);
		return;
	}
	const mediaAudio = ensureRecord$1(ensureRecord$1(ensureRecord$1(params.raw, "tools"), "media"), "audio");
	if ((Array.isArray(mediaAudio.models) ? mediaAudio.models : []).length === 0) {
		mediaAudio.enabled = true;
		mediaAudio.models = [mapped];
		params.changes.push(params.movedMessage);
		return;
	}
	params.changes.push(params.alreadySetMessage);
}
const LEGACY_CONFIG_MIGRATIONS_AUDIO = [defineLegacyConfigMigration({
	id: "audio.transcription-v2",
	describe: "Move audio.transcription to tools.media.audio.models",
	apply: (raw, changes) => {
		const audio = getRecord(raw.audio);
		if (audio?.transcription === void 0) return;
		applyLegacyAudioTranscriptionModel({
			raw,
			source: audio.transcription,
			changes,
			movedMessage: "Moved audio.transcription → tools.media.audio.models.",
			alreadySetMessage: "Removed audio.transcription (tools.media.audio.models already set).",
			invalidMessage: "Removed audio.transcription (invalid or empty command)."
		});
		delete audio.transcription;
		if (Object.keys(audio).length === 0) delete raw.audio;
		else raw.audio = audio;
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.channels.ts
function hasOwnKey(target, key) {
	return Object.prototype.hasOwnProperty.call(target, key);
}
function hasLegacyThreadBindingTtl(value) {
	const threadBindings = getRecord(value);
	return Boolean(threadBindings && hasOwnKey(threadBindings, "ttlHours"));
}
function hasLegacyThreadBindingSpawnSplit(value) {
	const threadBindings = getRecord(value);
	return Boolean(threadBindings && (hasOwnKey(threadBindings, "spawnSubagentSessions") || hasOwnKey(threadBindings, "spawnAcpSessions")));
}
function hasLegacyThreadBindingTtlInAccounts(value) {
	const accounts = getRecord(value);
	if (!accounts) return false;
	return Object.values(accounts).some((entry) => hasLegacyThreadBindingTtl(getRecord(entry)?.threadBindings));
}
function hasLegacyThreadBindingSpawnSplitInAccounts(value) {
	const accounts = getRecord(value);
	if (!accounts) return false;
	return Object.values(accounts).some((entry) => hasLegacyThreadBindingSpawnSplit(getRecord(entry)?.threadBindings));
}
function migrateThreadBindingsTtlHoursForPath(params) {
	const threadBindings = getRecord(params.owner.threadBindings);
	if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) return false;
	const hadIdleHours = threadBindings.idleHours !== void 0;
	if (!hadIdleHours) threadBindings.idleHours = threadBindings.ttlHours;
	delete threadBindings.ttlHours;
	params.owner.threadBindings = threadBindings;
	if (hadIdleHours) params.changes.push(`Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`);
	else params.changes.push(`Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`);
	return true;
}
function resolveMigratedSpawnSessions(threadBindings) {
	const subagent = threadBindings.spawnSubagentSessions;
	const acp = threadBindings.spawnAcpSessions;
	const subagentBool = typeof subagent === "boolean" ? subagent : void 0;
	const acpBool = typeof acp === "boolean" ? acp : void 0;
	if (subagentBool === void 0) return acpBool;
	if (acpBool === void 0) return subagentBool;
	return subagentBool && acpBool;
}
function migrateThreadBindingsSpawnSessionsForPath(params) {
	const threadBindings = getRecord(params.owner.threadBindings);
	if (!threadBindings || !hasLegacyThreadBindingSpawnSplit(threadBindings)) return false;
	const hadSpawnSessions = threadBindings.spawnSessions !== void 0;
	const resolved = resolveMigratedSpawnSessions(threadBindings);
	const oldSubagent = threadBindings.spawnSubagentSessions;
	const oldAcp = threadBindings.spawnAcpSessions;
	delete threadBindings.spawnSubagentSessions;
	delete threadBindings.spawnAcpSessions;
	if (!hadSpawnSessions && resolved !== void 0) threadBindings.spawnSessions = resolved;
	params.owner.threadBindings = threadBindings;
	if (hadSpawnSessions) params.changes.push(`Removed deprecated ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions (${params.pathPrefix}.threadBindings.spawnSessions already set).`);
	else if (typeof oldSubagent === "boolean" && typeof oldAcp === "boolean" && oldSubagent !== oldAcp) params.changes.push(`Collapsed conflicting ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`);
	else params.changes.push(`Moved ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`);
	return true;
}
function hasLegacyThreadBindingTtlInAnyChannel(value) {
	const channels = getRecord(value);
	if (!channels) return false;
	return Object.values(channels).some((entry) => {
		const channel = getRecord(entry);
		if (!channel) return false;
		return hasLegacyThreadBindingTtl(channel.threadBindings) || hasLegacyThreadBindingTtlInAccounts(channel.accounts);
	});
}
function hasLegacyThreadBindingSpawnSplitInAnyChannel(value) {
	const channels = getRecord(value);
	if (!channels) return false;
	return Object.values(channels).some((entry) => {
		const channel = getRecord(entry);
		if (!channel) return false;
		return hasLegacyThreadBindingSpawnSplit(channel.threadBindings) || hasLegacyThreadBindingSpawnSplitInAccounts(channel.accounts);
	});
}
const LEGACY_CONFIG_MIGRATIONS_CHANNELS = [defineLegacyConfigMigration({
	id: "thread-bindings.ttlHours->idleHours",
	describe: "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channel configs)",
	legacyRules: [
		{
			path: ["session", "threadBindings"],
			message: "session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyThreadBindingTtl(value)
		},
		{
			path: ["channels"],
			message: "channels.<id>.threadBindings.ttlHours was renamed to channels.<id>.threadBindings.idleHours. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyThreadBindingTtlInAnyChannel(value)
		},
		{
			path: ["session", "threadBindings"],
			message: "session.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by session.threadBindings.spawnSessions. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyThreadBindingSpawnSplit(value)
		},
		{
			path: ["channels"],
			message: "channels.<id>.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by channels.<id>.threadBindings.spawnSessions. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyThreadBindingSpawnSplitInAnyChannel(value)
		}
	],
	apply: (raw, changes) => {
		const session = getRecord(raw.session);
		if (session) {
			migrateThreadBindingsTtlHoursForPath({
				owner: session,
				pathPrefix: "session",
				changes
			});
			migrateThreadBindingsSpawnSessionsForPath({
				owner: session,
				pathPrefix: "session",
				changes
			});
			raw.session = session;
		}
		const channels = getRecord(raw.channels);
		if (!channels) return;
		for (const [channelId, channelRaw] of Object.entries(channels)) {
			const channel = getRecord(channelRaw);
			if (!channel) continue;
			migrateThreadBindingsTtlHoursForPath({
				owner: channel,
				pathPrefix: `channels.${channelId}`,
				changes
			});
			migrateThreadBindingsSpawnSessionsForPath({
				owner: channel,
				pathPrefix: `channels.${channelId}`,
				changes
			});
			const accounts = getRecord(channel.accounts);
			if (accounts) {
				for (const [accountId, accountRaw] of Object.entries(accounts)) {
					const account = getRecord(accountRaw);
					if (!account) continue;
					migrateThreadBindingsTtlHoursForPath({
						owner: account,
						pathPrefix: `channels.${channelId}.accounts.${accountId}`,
						changes
					});
					migrateThreadBindingsSpawnSessionsForPath({
						owner: account,
						pathPrefix: `channels.${channelId}.accounts.${accountId}`,
						changes
					});
					accounts[accountId] = account;
				}
				channel.accounts = accounts;
			}
			channels[channelId] = channel;
		}
		raw.channels = channels;
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.agents.ts
const AGENT_HEARTBEAT_KEYS = new Set([
	"every",
	"activeHours",
	"model",
	"session",
	"includeReasoning",
	"target",
	"directPolicy",
	"to",
	"accountId",
	"prompt",
	"ackMaxChars",
	"suppressToolErrorWarnings",
	"lightContext",
	"isolatedSession"
]);
const CHANNEL_HEARTBEAT_KEYS = new Set([
	"showOk",
	"showAlerts",
	"useIndicator"
]);
const MEMORY_SEARCH_RULE = {
	path: ["memorySearch"],
	message: "top-level memorySearch was moved; use agents.defaults.memorySearch instead. Run \"openclaw doctor --fix\"."
};
const HEARTBEAT_RULE = {
	path: ["heartbeat"],
	message: "top-level heartbeat is not a valid config path; use agents.defaults.heartbeat (cadence/target/model settings) or channels.defaults.heartbeat (showOk/showAlerts/useIndicator)."
};
const LEGACY_SANDBOX_SCOPE_RULES = [{
	path: [
		"agents",
		"defaults",
		"sandbox"
	],
	message: "agents.defaults.sandbox.perSession is legacy; use agents.defaults.sandbox.scope instead. Run \"openclaw doctor --fix\".",
	match: (value) => hasLegacySandboxPerSession(value)
}, {
	path: ["agents", "list"],
	message: "agents.list[].sandbox.perSession is legacy; use agents.list[].sandbox.scope instead. Run \"openclaw doctor --fix\".",
	match: (value) => hasLegacyAgentListSandboxPerSession(value)
}];
const LEGACY_AGENT_RUNTIME_POLICY_RULES = [{
	path: [
		"agents",
		"defaults",
		"embeddedHarness"
	],
	message: "agents.defaults.embeddedHarness is legacy; use agents.defaults.agentRuntime instead. Run \"openclaw doctor --fix\".",
	match: (value) => getRecord(value) !== null
}, {
	path: ["agents", "list"],
	message: "agents.list[].embeddedHarness is legacy; use agents.list[].agentRuntime instead. Run \"openclaw doctor --fix\".",
	match: (value) => hasLegacyAgentListEmbeddedHarness(value)
}];
const LEGACY_AGENT_LLM_TIMEOUT_RULES = [{
	path: [
		"agents",
		"defaults",
		"llm"
	],
	message: "agents.defaults.llm is legacy; use models.providers.<id>.timeoutSeconds for slow model/provider timeouts. Run \"openclaw doctor --fix\".",
	match: (value) => getRecord(value) !== null
}];
function sandboxScopeFromPerSession(perSession) {
	return perSession ? "session" : "shared";
}
function splitLegacyHeartbeat(legacyHeartbeat) {
	const agentHeartbeat = {};
	const channelHeartbeat = {};
	for (const [key, value] of Object.entries(legacyHeartbeat)) {
		if (isBlockedObjectKey(key)) continue;
		if (CHANNEL_HEARTBEAT_KEYS.has(key)) {
			channelHeartbeat[key] = value;
			continue;
		}
		if (AGENT_HEARTBEAT_KEYS.has(key)) {
			agentHeartbeat[key] = value;
			continue;
		}
		agentHeartbeat[key] = value;
	}
	return {
		agentHeartbeat: Object.keys(agentHeartbeat).length > 0 ? agentHeartbeat : null,
		channelHeartbeat: Object.keys(channelHeartbeat).length > 0 ? channelHeartbeat : null
	};
}
function mergeLegacyIntoDefaults(params) {
	const root = ensureRecord$1(params.raw, params.rootKey);
	const defaults = ensureRecord$1(root, "defaults");
	const existing = getRecord(defaults[params.fieldKey]);
	if (!existing) {
		defaults[params.fieldKey] = params.legacyValue;
		params.changes.push(params.movedMessage);
	} else {
		const merged = structuredClone(existing);
		mergeMissing(merged, params.legacyValue);
		defaults[params.fieldKey] = merged;
		params.changes.push(params.mergedMessage);
	}
	root.defaults = defaults;
	params.raw[params.rootKey] = root;
}
function hasLegacySandboxPerSession(value) {
	const sandbox = getRecord(value);
	return Boolean(sandbox && Object.prototype.hasOwnProperty.call(sandbox, "perSession"));
}
function hasLegacyAgentListSandboxPerSession(value) {
	if (!Array.isArray(value)) return false;
	return value.some((agent) => hasLegacySandboxPerSession(getRecord(agent)?.sandbox));
}
function hasLegacyAgentListEmbeddedHarness(value) {
	if (!Array.isArray(value)) return false;
	return value.some((agent) => getRecord(getRecord(agent)?.embeddedHarness) !== null);
}
function migrateLegacySandboxPerSession(sandbox, pathLabel, changes) {
	if (!Object.prototype.hasOwnProperty.call(sandbox, "perSession")) return;
	const rawPerSession = sandbox.perSession;
	if (typeof rawPerSession !== "boolean") return;
	if (sandbox.scope === void 0) {
		sandbox.scope = sandboxScopeFromPerSession(rawPerSession);
		changes.push(`Moved ${pathLabel}.perSession → ${pathLabel}.scope (${String(sandbox.scope)}).`);
	} else changes.push(`Removed ${pathLabel}.perSession (${pathLabel}.scope already set).`);
	delete sandbox.perSession;
}
function migrateLegacyAgentRuntimePolicy(container, pathLabel, changes) {
	const legacy = getRecord(container.embeddedHarness);
	if (!legacy) return;
	const existing = getRecord(container.agentRuntime);
	const next = existing ? structuredClone(existing) : {};
	if (next.id === void 0 && legacy.runtime !== void 0) next.id = legacy.runtime;
	if (next.fallback === void 0 && legacy.fallback !== void 0) next.fallback = legacy.fallback;
	if (Object.keys(next).length > 0) container.agentRuntime = next;
	delete container.embeddedHarness;
	changes.push(`Moved ${pathLabel}.embeddedHarness → ${pathLabel}.agentRuntime.`);
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS = [
	defineLegacyConfigMigration({
		id: "agents.defaults.llm->models.providers.timeoutSeconds",
		describe: "Remove legacy agents.defaults.llm timeout config",
		legacyRules: LEGACY_AGENT_LLM_TIMEOUT_RULES,
		apply: (raw, changes) => {
			const defaults = getRecord(getRecord(raw.agents)?.defaults);
			if (!defaults || getRecord(defaults.llm) === null) return;
			delete defaults.llm;
			changes.push("Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds.");
		}
	}),
	defineLegacyConfigMigration({
		id: "agents.embeddedHarness->agentRuntime",
		describe: "Move legacy embeddedHarness runtime policy to agentRuntime",
		legacyRules: LEGACY_AGENT_RUNTIME_POLICY_RULES,
		apply: (raw, changes) => {
			const agents = getRecord(raw.agents);
			const defaults = getRecord(agents?.defaults);
			if (defaults) migrateLegacyAgentRuntimePolicy(defaults, "agents.defaults", changes);
			if (!Array.isArray(agents?.list)) return;
			for (const [index, agent] of agents.list.entries()) {
				const agentRecord = getRecord(agent);
				if (!agentRecord) continue;
				migrateLegacyAgentRuntimePolicy(agentRecord, `agents.list.${index}`, changes);
			}
		}
	}),
	defineLegacyConfigMigration({
		id: "agents.sandbox.perSession->scope",
		describe: "Move legacy agent sandbox perSession aliases to sandbox.scope",
		legacyRules: LEGACY_SANDBOX_SCOPE_RULES,
		apply: (raw, changes) => {
			const agents = getRecord(raw.agents);
			const defaultSandbox = getRecord(getRecord(agents?.defaults)?.sandbox);
			if (defaultSandbox) migrateLegacySandboxPerSession(defaultSandbox, "agents.defaults.sandbox", changes);
			if (!Array.isArray(agents?.list)) return;
			for (const [index, agent] of agents.list.entries()) {
				const sandbox = getRecord(getRecord(agent)?.sandbox);
				if (!sandbox) continue;
				migrateLegacySandboxPerSession(sandbox, `agents.list.${index}.sandbox`, changes);
			}
		}
	}),
	defineLegacyConfigMigration({
		id: "memorySearch->agents.defaults.memorySearch",
		describe: "Move top-level memorySearch to agents.defaults.memorySearch",
		legacyRules: [MEMORY_SEARCH_RULE],
		apply: (raw, changes) => {
			const legacyMemorySearch = getRecord(raw.memorySearch);
			if (!legacyMemorySearch) return;
			mergeLegacyIntoDefaults({
				raw,
				rootKey: "agents",
				fieldKey: "memorySearch",
				legacyValue: legacyMemorySearch,
				changes,
				movedMessage: "Moved memorySearch → agents.defaults.memorySearch.",
				mergedMessage: "Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values)."
			});
			delete raw.memorySearch;
		}
	}),
	defineLegacyConfigMigration({
		id: "heartbeat->agents.defaults.heartbeat",
		describe: "Move top-level heartbeat to agents.defaults.heartbeat/channels.defaults.heartbeat",
		legacyRules: [HEARTBEAT_RULE],
		apply: (raw, changes) => {
			const legacyHeartbeat = getRecord(raw.heartbeat);
			if (!legacyHeartbeat) return;
			const { agentHeartbeat, channelHeartbeat } = splitLegacyHeartbeat(legacyHeartbeat);
			if (agentHeartbeat) mergeLegacyIntoDefaults({
				raw,
				rootKey: "agents",
				fieldKey: "heartbeat",
				legacyValue: agentHeartbeat,
				changes,
				movedMessage: "Moved heartbeat → agents.defaults.heartbeat.",
				mergedMessage: "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values)."
			});
			if (channelHeartbeat) mergeLegacyIntoDefaults({
				raw,
				rootKey: "channels",
				fieldKey: "heartbeat",
				legacyValue: channelHeartbeat,
				changes,
				movedMessage: "Moved heartbeat visibility → channels.defaults.heartbeat.",
				mergedMessage: "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values)."
			});
			if (!agentHeartbeat && !channelHeartbeat) changes.push("Removed empty top-level heartbeat.");
			delete raw.heartbeat;
		}
	})
];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.gateway.ts
const GATEWAY_BIND_RULE = {
	path: ["gateway", "bind"],
	message: "gateway.bind host aliases (for example 0.0.0.0/localhost) are legacy; use bind modes (lan/loopback/custom/tailnet/auto) instead. Run \"openclaw doctor --fix\".",
	match: (value) => isLegacyGatewayBindHostAlias(value),
	requireSourceLiteral: true
};
function isLegacyGatewayBindHostAlias(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return false;
	if (normalized === "auto" || normalized === "loopback" || normalized === "lan" || normalized === "tailnet" || normalized === "custom") return false;
	return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]" || normalized === "*" || normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}
function escapeControlForLog(value) {
	return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY = [defineLegacyConfigMigration({
	id: "gateway.controlUi.allowedOrigins-seed-for-non-loopback",
	describe: "Seed gateway.controlUi.allowedOrigins for existing non-loopback gateway installs",
	apply: (raw, changes) => {
		const gateway = getRecord(raw.gateway);
		if (!gateway) return;
		const bind = gateway.bind;
		if (!isGatewayNonLoopbackBindMode(bind)) return;
		const controlUi = getRecord(gateway.controlUi) ?? {};
		if (hasConfiguredControlUiAllowedOrigins({
			allowedOrigins: controlUi.allowedOrigins,
			dangerouslyAllowHostHeaderOriginFallback: controlUi.dangerouslyAllowHostHeaderOriginFallback
		})) return;
		const origins = buildDefaultControlUiAllowedOrigins({
			port: resolveGatewayPortWithDefault(gateway.port, DEFAULT_GATEWAY_PORT),
			bind,
			customBindHost: typeof gateway.customBindHost === "string" ? gateway.customBindHost : void 0
		});
		gateway.controlUi = {
			...controlUi,
			allowedOrigins: origins
		};
		raw.gateway = gateway;
		changes.push(`Seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} for bind=${bind}. Required since v2026.2.26. Add other machine origins to gateway.controlUi.allowedOrigins if needed.`);
	}
}), defineLegacyConfigMigration({
	id: "gateway.bind.host-alias->bind-mode",
	describe: "Normalize gateway.bind host aliases to supported bind modes",
	legacyRules: [GATEWAY_BIND_RULE],
	apply: (raw, changes) => {
		const gateway = getRecord(raw.gateway);
		if (!gateway) return;
		const bindRaw = gateway.bind;
		if (typeof bindRaw !== "string") return;
		const normalized = normalizeOptionalLowercaseString(bindRaw);
		if (!normalized) return;
		let mapped;
		if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]" || normalized === "*") mapped = "lan";
		else if (normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]") mapped = "loopback";
		if (!mapped || normalized === mapped) return;
		gateway.bind = mapped;
		raw.gateway = gateway;
		changes.push(`Normalized gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}".`);
	}
})];
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP = [defineLegacyConfigMigration({
	id: "mcp.servers.type->transport",
	describe: "Move CLI-native MCP server type aliases to OpenClaw transport",
	legacyRules: [{
		path: ["mcp", "servers"],
		message: "mcp.servers entries use OpenClaw transport names; CLI-native type aliases are legacy here. Run \"openclaw doctor --fix\".",
		match: (value) => isRecord(value) && Object.values(value).some((server) => isRecord(server) && isKnownCliMcpTypeAlias(server.type))
	}],
	apply: (raw, changes) => {
		const mcp = isRecord(raw.mcp) ? raw.mcp : void 0;
		const servers = isRecord(mcp?.servers) ? mcp?.servers : void 0;
		if (!servers) return;
		for (const [serverName, rawServer] of Object.entries(servers)) {
			if (!isRecord(rawServer) || !isKnownCliMcpTypeAlias(rawServer.type)) continue;
			const rawType = typeof rawServer.type === "string" ? rawServer.type : "";
			const alias = resolveOpenClawMcpTransportAlias(rawServer.type);
			if (typeof rawServer.transport !== "string" && alias) {
				rawServer.transport = alias;
				changes.push(`Moved mcp.servers.${serverName}.type "${rawType}" → transport "${alias}".`);
			} else if (typeof rawServer.transport === "string") changes.push(`Removed mcp.servers.${serverName}.type (transport "${rawServer.transport}" already set).`);
			else changes.push(`Removed mcp.servers.${serverName}.type "${rawType}".`);
			delete rawServer.type;
		}
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-x-search-migrate.ts
const XAI_PLUGIN_ID = "xai";
const X_SEARCH_LEGACY_PATH = "tools.web.x_search";
const XAI_WEB_SEARCH_PLUGIN_KEY_PATH = `plugins.entries.${XAI_PLUGIN_ID}.config.webSearch.apiKey`;
function cloneRecord(value) {
	if (!value) return value;
	return { ...value };
}
function ensureRecord(target, key) {
	const current = target[key];
	if (isRecord(current)) return current;
	const next = {};
	target[key] = next;
	return next;
}
function resolveLegacyXSearchConfig(raw) {
	if (!isRecord(raw)) return;
	const tools = isRecord(raw.tools) ? raw.tools : void 0;
	const web = isRecord(tools?.web) ? tools.web : void 0;
	return isRecord(web?.x_search) ? web.x_search : void 0;
}
function resolveLegacyXSearchAuth(legacy) {
	return legacy.apiKey;
}
function migrateLegacyXSearchConfig(raw) {
	if (!isRecord(raw)) return {
		config: raw,
		changes: []
	};
	const legacy = resolveLegacyXSearchConfig(raw);
	if (!legacy || !Object.prototype.hasOwnProperty.call(legacy, "apiKey")) return {
		config: raw,
		changes: []
	};
	const nextRoot = structuredClone(raw);
	const web = ensureRecord(ensureRecord(nextRoot, "tools"), "web");
	const nextLegacy = cloneRecord(legacy) ?? {};
	delete nextLegacy.apiKey;
	if (Object.keys(nextLegacy).length === 0) delete web.x_search;
	else web.x_search = nextLegacy;
	const entry = ensureRecord(ensureRecord(ensureRecord(nextRoot, "plugins"), "entries"), XAI_PLUGIN_ID);
	const hadEnabled = entry.enabled !== void 0;
	if (!hadEnabled) entry.enabled = true;
	const config = ensureRecord(entry, "config");
	const auth = resolveLegacyXSearchAuth(legacy);
	const changes = [];
	if (auth !== void 0) {
		const existingWebSearch = isRecord(config.webSearch) ? cloneRecord(config.webSearch) : void 0;
		if (!existingWebSearch) {
			config.webSearch = { apiKey: auth };
			changes.push(`Moved ${X_SEARCH_LEGACY_PATH}.apiKey → ${XAI_WEB_SEARCH_PLUGIN_KEY_PATH}.`);
		} else if (!Object.prototype.hasOwnProperty.call(existingWebSearch, "apiKey")) {
			existingWebSearch.apiKey = auth;
			config.webSearch = existingWebSearch;
			changes.push(`Merged ${X_SEARCH_LEGACY_PATH}.apiKey → ${XAI_WEB_SEARCH_PLUGIN_KEY_PATH} (filled missing plugin auth).`);
		} else changes.push(`Removed ${X_SEARCH_LEGACY_PATH}.apiKey (${XAI_WEB_SEARCH_PLUGIN_KEY_PATH} already set).`);
	}
	if (auth !== void 0 && Object.keys(nextLegacy).length === 0 && !hadEnabled) changes.push(`Removed empty ${X_SEARCH_LEGACY_PATH}.`);
	return {
		config: nextRoot,
		changes
	};
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS = [defineLegacyConfigMigration({
	id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
	describe: "Move legacy x_search auth into the xAI plugin webSearch config",
	legacyRules: [{
		path: [
			"tools",
			"web",
			"x_search",
			"apiKey"
		],
		message: "tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run \"openclaw doctor --fix\"."
	}],
	apply: (raw, changes) => {
		const migrated = migrateLegacyXSearchConfig(raw);
		if (!migrated.changes.length) return;
		for (const key of Object.keys(raw)) delete raw[key];
		Object.assign(raw, migrated.config);
		changes.push(...migrated.changes);
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.session.ts
function hasLegacyRotateBytes(value) {
	const maintenance = getRecord(value);
	return Boolean(maintenance && Object.prototype.hasOwnProperty.call(maintenance, "rotateBytes"));
}
function hasLegacyParentForkMaxTokens(value) {
	const session = getRecord(value);
	return Boolean(session && Object.prototype.hasOwnProperty.call(session, "parentForkMaxTokens"));
}
const LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE = {
	path: ["session", "maintenance"],
	message: "session.maintenance.rotateBytes is deprecated and ignored; run \"openclaw doctor --fix\" to remove it.",
	match: hasLegacyRotateBytes
};
const LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE = {
	path: ["session"],
	message: "session.parentForkMaxTokens was removed; parent fork sizing is automatic. Run \"openclaw doctor --fix\" to remove it.",
	match: hasLegacyParentForkMaxTokens
};
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION = [defineLegacyConfigMigration({
	id: "session.maintenance.rotateBytes",
	describe: "Remove deprecated session.maintenance.rotateBytes",
	legacyRules: [LEGACY_SESSION_MAINTENANCE_ROTATE_BYTES_RULE],
	apply: (raw, changes) => {
		const maintenance = getRecord(getRecord(raw.session)?.maintenance);
		if (!maintenance || !Object.prototype.hasOwnProperty.call(maintenance, "rotateBytes")) return;
		delete maintenance.rotateBytes;
		changes.push("Removed deprecated session.maintenance.rotateBytes.");
	}
}), defineLegacyConfigMigration({
	id: "session.parentForkMaxTokens",
	describe: "Remove legacy session.parentForkMaxTokens",
	legacyRules: [LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE],
	apply: (raw, changes) => {
		const session = getRecord(raw.session);
		if (!session || !Object.prototype.hasOwnProperty.call(session, "parentForkMaxTokens")) return;
		delete session.parentForkMaxTokens;
		changes.push("Removed session.parentForkMaxTokens; parent fork sizing is automatic.");
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.tts.ts
const LEGACY_TTS_PROVIDER_KEYS = [
	"openai",
	"elevenlabs",
	"microsoft",
	"edge"
];
const LEGACY_TTS_PLUGIN_IDS = new Set(["voice-call"]);
function isLegacyEdgeProviderId(value) {
	return typeof value === "string" && value.trim().toLowerCase() === "edge";
}
function hasLegacyTtsProviderKeys(value) {
	const tts = getRecord(value);
	if (!tts) return false;
	if (isLegacyEdgeProviderId(tts.provider)) return true;
	if (LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(tts, key))) return true;
	const providers = getRecord(tts.providers);
	return Boolean(providers && Object.prototype.hasOwnProperty.call(providers, "edge"));
}
function hasLegacyPluginEntryTtsProviderKeys(value) {
	const entries = getRecord(value);
	if (!entries) return false;
	return Object.entries(entries).some(([pluginId, entryValue]) => {
		if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) return false;
		return hasLegacyTtsProviderKeys(getRecord(getRecord(entryValue)?.config)?.tts);
	});
}
function hasLegacyTtsEnabled(value) {
	return typeof getRecord(value)?.enabled === "boolean";
}
function hasLegacyTtsEnabledInAgentLocations(value) {
	const agents = getRecord(value);
	if (hasLegacyTtsEnabled(getRecord(getRecord(agents?.defaults)?.tts))) return true;
	return (Array.isArray(agents?.list) ? agents.list : []).some((entry) => hasLegacyTtsEnabled(getRecord(getRecord(entry)?.tts)));
}
function hasLegacyTtsEnabledInChannelLocations(value) {
	const channels = getRecord(value);
	for (const [channelId, channelValue] of Object.entries(channels ?? {})) {
		if (isBlockedObjectKey(channelId)) continue;
		const channel = getRecord(channelValue);
		if (hasLegacyTtsEnabled(getRecord(channel?.tts))) return true;
		const accounts = getRecord(channel?.accounts);
		for (const [accountId, accountValue] of Object.entries(accounts ?? {})) {
			if (isBlockedObjectKey(accountId)) continue;
			if (hasLegacyTtsEnabled(getRecord(getRecord(accountValue)?.tts))) return true;
		}
	}
	return false;
}
function hasLegacyTtsEnabledInPluginLocations(value) {
	const entries = getRecord(value);
	if (!entries) return false;
	return Object.entries(entries).some(([pluginId, entryValue]) => {
		if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) return false;
		return hasLegacyTtsEnabled(getRecord(getRecord(getRecord(entryValue)?.config)?.tts));
	});
}
function getOrCreateTtsProviders(tts) {
	const providers = getRecord(tts.providers) ?? {};
	tts.providers = providers;
	return providers;
}
function mergeLegacyTtsProviderConfig(tts, legacyKey, providerId) {
	const legacyValue = getRecord(tts[legacyKey]);
	if (!legacyValue) return false;
	const providers = getOrCreateTtsProviders(tts);
	const existing = getRecord(providers[providerId]) ?? {};
	const merged = structuredClone(existing);
	mergeMissing(merged, legacyValue);
	providers[providerId] = merged;
	delete tts[legacyKey];
	return true;
}
function mergeLegacyTtsProviderAliasConfig(tts, aliasKey, providerId) {
	const providers = getRecord(tts.providers);
	const aliasValue = getRecord(providers?.[aliasKey]);
	if (!providers || !aliasValue) return false;
	const existing = getRecord(providers[providerId]) ?? {};
	const merged = structuredClone(existing);
	mergeMissing(merged, aliasValue);
	providers[providerId] = merged;
	delete providers[aliasKey];
	return true;
}
function migrateLegacyTtsConfig(tts, pathLabel, changes) {
	if (!tts) return;
	if (isLegacyEdgeProviderId(tts.provider)) {
		tts.provider = "microsoft";
		changes.push(`Moved ${pathLabel}.provider "edge" → "microsoft".`);
	}
	const movedOpenAI = mergeLegacyTtsProviderConfig(tts, "openai", "openai");
	const movedElevenLabs = mergeLegacyTtsProviderConfig(tts, "elevenlabs", "elevenlabs");
	const movedMicrosoft = mergeLegacyTtsProviderConfig(tts, "microsoft", "microsoft");
	const movedProviderEdge = mergeLegacyTtsProviderAliasConfig(tts, "edge", "microsoft");
	const movedEdge = mergeLegacyTtsProviderConfig(tts, "edge", "microsoft");
	if (movedOpenAI) changes.push(`Moved ${pathLabel}.openai → ${pathLabel}.providers.openai.`);
	if (movedElevenLabs) changes.push(`Moved ${pathLabel}.elevenlabs → ${pathLabel}.providers.elevenlabs.`);
	if (movedMicrosoft) changes.push(`Moved ${pathLabel}.microsoft → ${pathLabel}.providers.microsoft.`);
	if (movedProviderEdge) changes.push(`Moved ${pathLabel}.providers.edge → ${pathLabel}.providers.microsoft.`);
	if (movedEdge) changes.push(`Moved ${pathLabel}.edge → ${pathLabel}.providers.microsoft.`);
}
function migrateLegacyTtsEnabled(tts, pathLabel, changes) {
	if (!tts || typeof tts.enabled !== "boolean") return;
	const nextAuto = tts.enabled ? "always" : "off";
	delete tts.enabled;
	if (typeof tts.auto === "string" && tts.auto.trim()) {
		changes.push(`Removed ${pathLabel}.enabled because ${pathLabel}.auto is already set.`);
		return;
	}
	tts.auto = nextAuto;
	changes.push(`Moved ${pathLabel}.enabled → ${pathLabel}.auto "${nextAuto}".`);
}
function visitKnownTtsConfigLocations(raw, visit) {
	visit(getRecord(getRecord(raw.messages)?.tts), "messages.tts");
	const agents = getRecord(raw.agents);
	visit(getRecord(getRecord(agents?.defaults)?.tts), "agents.defaults.tts");
	(Array.isArray(agents?.list) ? agents.list : []).forEach((entry, index) => {
		visit(getRecord(getRecord(entry)?.tts), `agents.list[${index}].tts`);
	});
	const channels = getRecord(raw.channels);
	for (const [channelId, channelValue] of Object.entries(channels ?? {})) {
		if (isBlockedObjectKey(channelId)) continue;
		const channel = getRecord(channelValue);
		visit(getRecord(channel?.tts), `channels.${channelId}.tts`);
		const accounts = getRecord(channel?.accounts);
		for (const [accountId, accountValue] of Object.entries(accounts ?? {})) {
			if (isBlockedObjectKey(accountId)) continue;
			visit(getRecord(getRecord(accountValue)?.tts), `channels.${channelId}.accounts.${accountId}.tts`);
		}
	}
	const pluginEntries = getRecord(getRecord(raw.plugins)?.entries);
	for (const [pluginId, entryValue] of Object.entries(pluginEntries ?? {})) {
		if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) continue;
		visit(getRecord(getRecord(getRecord(entryValue)?.config)?.tts), `plugins.entries.${pluginId}.config.tts`);
	}
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS = [defineLegacyConfigMigration({
	id: "tts.providers-generic-shape",
	describe: "Move legacy bundled TTS config keys into messages.tts.providers",
	legacyRules: [{
		path: ["messages", "tts"],
		message: "messages.tts legacy provider aliases/keys are legacy; use provider: \"microsoft\" and messages.tts.providers.<provider>. Run \"openclaw doctor --fix\".",
		match: (value) => hasLegacyTtsProviderKeys(value)
	}, {
		path: ["plugins", "entries"],
		message: "plugins.entries.voice-call.config.tts legacy provider aliases/keys are legacy; use provider: \"microsoft\" and plugins.entries.voice-call.config.tts.providers.<provider>. Run \"openclaw doctor --fix\".",
		match: (value) => hasLegacyPluginEntryTtsProviderKeys(value)
	}],
	apply: (raw, changes) => {
		migrateLegacyTtsConfig(getRecord(getRecord(raw.messages)?.tts), "messages.tts", changes);
		const pluginEntries = getRecord(getRecord(raw.plugins)?.entries);
		if (!pluginEntries) return;
		for (const [pluginId, entryValue] of Object.entries(pluginEntries)) {
			if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) continue;
			migrateLegacyTtsConfig(getRecord(getRecord(getRecord(entryValue)?.config)?.tts), `plugins.entries.${pluginId}.config.tts`, changes);
		}
	}
}), defineLegacyConfigMigration({
	id: "tts.enabled-auto-mode",
	describe: "Move legacy TTS enabled toggles to auto mode",
	legacyRules: [
		{
			path: ["messages", "tts"],
			message: "messages.tts.enabled is legacy; use messages.tts.auto. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyTtsEnabled(value)
		},
		{
			path: ["agents"],
			message: "agents.*.tts.enabled is legacy; use agents.*.tts.auto. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyTtsEnabledInAgentLocations(value)
		},
		{
			path: ["channels"],
			message: "channels.*.tts.enabled is legacy; use channels.*.tts.auto. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyTtsEnabledInChannelLocations(value)
		},
		{
			path: ["plugins", "entries"],
			message: "plugins.entries.voice-call.config.tts.enabled is legacy; use plugins.entries.voice-call.config.tts.auto. Run \"openclaw doctor --fix\".",
			match: (value) => hasLegacyTtsEnabledInPluginLocations(value)
		}
	],
	apply: (raw, changes) => {
		visitKnownTtsConfigLocations(raw, (tts, pathLabel) => migrateLegacyTtsEnabled(tts, pathLabel, changes));
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.ts
const LEGACY_CONFIG_MIGRATIONS_RUNTIME = [
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS
];
//#endregion
//#region src/commands/doctor/shared/legacy-web-search-migrate.ts
const MODERN_SCOPED_WEB_SEARCH_KEYS = new Set(["openaiCodex"]);
const NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS = new Set(["tavily"]);
const LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID = "brave";
function getBundledLegacyWebSearchOwners() {
	const owners = /* @__PURE__ */ new Map();
	for (const plugin of loadManifestMetadataSnapshot({
		config: {},
		env: process.env
	}).plugins) {
		if (plugin.origin !== "bundled") continue;
		for (const providerId of plugin.contracts?.webSearchProviders ?? []) if (!owners.has(providerId)) owners.set(providerId, plugin.id);
	}
	return owners;
}
function getLegacyWebSearchProviderIds(owners = getBundledLegacyWebSearchOwners()) {
	return [...owners.keys()].filter((providerId) => !NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS.has(providerId)).toSorted((left, right) => left.localeCompare(right));
}
function getLegacyWebSearchProviderIdSet(owners) {
	return new Set(getLegacyWebSearchProviderIds(owners));
}
function resolveLegacySearchConfig(raw) {
	if (!isRecord(raw)) return;
	const tools = isRecord(raw.tools) ? raw.tools : void 0;
	const web = isRecord(tools?.web) ? tools.web : void 0;
	return isRecord(web?.search) ? web.search : void 0;
}
function copyLegacyProviderConfig(search, providerKey) {
	const current = search[providerKey];
	return isRecord(current) ? cloneRecord$1(current) : void 0;
}
function hasMappedLegacyWebSearchConfig(raw, owners) {
	const search = resolveLegacySearchConfig(raw);
	if (!search) return false;
	if (hasOwnKey$1(search, "apiKey")) return true;
	return getLegacyWebSearchProviderIds(owners).some((providerId) => isRecord(search[providerId]));
}
function resolveLegacyGlobalWebSearchMigration(search, owners) {
	const legacyProviderConfig = copyLegacyProviderConfig(search, LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID);
	const payload = legacyProviderConfig ?? {};
	const hasLegacyApiKey = hasOwnKey$1(search, "apiKey");
	if (hasLegacyApiKey) payload.apiKey = search.apiKey;
	if (Object.keys(payload).length === 0) return null;
	const pluginId = owners.get(LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID) ?? LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID;
	return {
		pluginId,
		payload,
		legacyPath: hasLegacyApiKey ? "tools.web.search.apiKey" : `tools.web.search.${LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID}`,
		targetPath: hasLegacyApiKey && !legacyProviderConfig ? `plugins.entries.${pluginId}.config.webSearch.apiKey` : `plugins.entries.${pluginId}.config.webSearch`
	};
}
function migratePluginWebSearchConfig(params) {
	const entry = ensureRecord$2(ensureRecord$2(ensureRecord$2(params.root, "plugins"), "entries"), params.pluginId);
	const config = ensureRecord$2(entry, "config");
	const hadEnabled = entry.enabled !== void 0;
	const existing = isRecord(config.webSearch) ? cloneRecord$1(config.webSearch) : void 0;
	if (!hadEnabled) entry.enabled = true;
	if (!existing) {
		config.webSearch = cloneRecord$1(params.payload);
		params.changes.push(`Moved ${params.legacyPath} → ${params.targetPath}.`);
		return;
	}
	const merged = cloneRecord$1(existing);
	mergeMissing(merged, params.payload);
	const changed = JSON.stringify(merged) !== JSON.stringify(existing) || !hadEnabled;
	config.webSearch = merged;
	if (changed) {
		params.changes.push(`Merged ${params.legacyPath} → ${params.targetPath} (filled missing fields from legacy; kept explicit plugin config values).`);
		return;
	}
	params.changes.push(`Removed ${params.legacyPath} (${params.targetPath} already set).`);
}
function listLegacyWebSearchConfigPaths(raw) {
	const owners = getBundledLegacyWebSearchOwners();
	const search = resolveLegacySearchConfig(raw);
	if (!search) return [];
	const paths = [];
	if ("apiKey" in search) paths.push("tools.web.search.apiKey");
	for (const providerId of getLegacyWebSearchProviderIds(owners)) {
		const scoped = search[providerId];
		if (isRecord(scoped)) for (const key of Object.keys(scoped)) paths.push(`tools.web.search.${providerId}.${key}`);
	}
	return paths;
}
function migrateLegacyWebSearchConfig(raw) {
	if (!isRecord(raw)) return {
		config: raw,
		changes: []
	};
	const owners = getBundledLegacyWebSearchOwners();
	if (!hasMappedLegacyWebSearchConfig(raw, owners)) return {
		config: raw,
		changes: []
	};
	return normalizeLegacyWebSearchConfigRecord(raw, owners);
}
function normalizeLegacyWebSearchConfigRecord(raw, owners) {
	const nextRoot = cloneRecord$1(raw);
	const web = ensureRecord$2(ensureRecord$2(nextRoot, "tools"), "web");
	const search = resolveLegacySearchConfig(nextRoot);
	if (!search) return {
		config: raw,
		changes: []
	};
	const nextSearch = {};
	const changes = [];
	for (const [key, value] of Object.entries(search)) {
		if (key === "apiKey") continue;
		if (getLegacyWebSearchProviderIdSet(owners).has(key) && isRecord(value)) continue;
		if (MODERN_SCOPED_WEB_SEARCH_KEYS.has(key) || !isRecord(value)) nextSearch[key] = value;
	}
	web.search = nextSearch;
	const globalSearchMigration = resolveLegacyGlobalWebSearchMigration(search, owners);
	if (globalSearchMigration) migratePluginWebSearchConfig({
		root: nextRoot,
		legacyPath: globalSearchMigration.legacyPath,
		targetPath: globalSearchMigration.targetPath,
		pluginId: globalSearchMigration.pluginId,
		payload: globalSearchMigration.payload,
		changes
	});
	for (const providerId of getLegacyWebSearchProviderIds(owners)) {
		if (providerId === LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID) continue;
		const scoped = copyLegacyProviderConfig(search, providerId);
		if (!scoped || Object.keys(scoped).length === 0) continue;
		const pluginId = owners.get(providerId);
		if (!pluginId) continue;
		migratePluginWebSearchConfig({
			root: nextRoot,
			legacyPath: `tools.web.search.${providerId}`,
			targetPath: `plugins.entries.${pluginId}.config.webSearch`,
			pluginId,
			payload: scoped,
			changes
		});
	}
	return {
		config: nextRoot,
		changes
	};
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.web-search.ts
const LEGACY_WEB_SEARCH_RULES = [{
	path: [
		"tools",
		"web",
		"search"
	],
	message: "tools.web.search provider-owned config moved to plugins.entries.<plugin>.config.webSearch. Run \"openclaw doctor --fix\".",
	match: (_value, root) => listLegacyWebSearchConfigPaths(root).length > 0,
	requireSourceLiteral: true
}];
function replaceRootRecord(target, replacement) {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, replacement);
}
const LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH = [defineLegacyConfigMigration({
	id: "tools.web.search-provider-config->plugins.entries",
	describe: "Move legacy tools.web.search provider-owned config into plugins.entries.<plugin>.config.webSearch",
	legacyRules: LEGACY_WEB_SEARCH_RULES,
	apply: (raw, changes) => {
		const migrated = migrateLegacyWebSearchConfig(raw);
		if (migrated.changes.length === 0) return;
		replaceRootRecord(raw, migrated.config);
		changes.push(...migrated.changes);
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.ts
const LEGACY_CONFIG_MIGRATION_SPECS = [
	...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
	...LEGACY_CONFIG_MIGRATIONS_AUDIO,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
	...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH
];
const LEGACY_CONFIG_MIGRATIONS = LEGACY_CONFIG_MIGRATION_SPECS.map(({ legacyRules: _legacyRules, ...migration }) => migration);
const LEGACY_CONFIG_MIGRATION_RULES = LEGACY_CONFIG_MIGRATION_SPECS.flatMap((migration) => migration.legacyRules ?? []);
//#endregion
//#region src/config/legacy.ts
function getPathValue(root, path) {
	let cursor = root;
	for (const key of path) {
		if (!cursor || typeof cursor !== "object") return;
		cursor = cursor[key];
	}
	return cursor;
}
function findLegacyConfigIssues(raw, sourceRaw, extraRules = [], _touchedPaths) {
	if (!raw || typeof raw !== "object") return [];
	const root = raw;
	const sourceRoot = sourceRaw && typeof sourceRaw === "object" ? sourceRaw : root;
	const issues = [];
	for (const rule of [...LEGACY_CONFIG_MIGRATION_RULES, ...extraRules]) {
		const cursor = getPathValue(root, rule.path);
		if (cursor !== void 0 && (!rule.match || rule.match(cursor, root))) {
			if (rule.requireSourceLiteral) {
				const sourceCursor = getPathValue(sourceRoot, rule.path);
				if (sourceCursor === void 0) continue;
				if (rule.match && !rule.match(sourceCursor, sourceRoot)) continue;
			}
			issues.push({
				path: rule.path.join("."),
				message: rule.message
			});
		}
	}
	return issues;
}
//#endregion
//#region src/commands/doctor/shared/legacy-config-issues.ts
function collectConfiguredChannelIds(raw) {
	if (!raw || typeof raw !== "object") return /* @__PURE__ */ new Set();
	const channels = raw.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return /* @__PURE__ */ new Set();
	return new Set(Object.keys(channels).filter((channelId) => channelId !== "defaults"));
}
function collectPluginLegacyConfigRules(raw, touchedPaths) {
	const channelIds = collectConfiguredChannelIds(raw);
	const pluginIds = (touchedPaths ? collectRelevantDoctorPluginIdsForTouchedPaths({
		raw,
		touchedPaths
	}) : collectRelevantDoctorPluginIds(raw)).filter((pluginId) => !channelIds.has(pluginId));
	if (pluginIds.length === 0) return [];
	return listPluginDoctorLegacyConfigRules({ pluginIds });
}
function findDoctorLegacyConfigIssues(raw, sourceRaw, touchedPaths) {
	return findLegacyConfigIssues(raw, sourceRaw, [...collectChannelLegacyConfigRules(raw, touchedPaths), ...collectPluginLegacyConfigRules(raw, touchedPaths)], touchedPaths);
}
//#endregion
export { mergeMissing as a, migrateLegacyXSearchConfig as i, LEGACY_CONFIG_MIGRATIONS as n, loadBundledChannelDoctorContractApi as o, migrateLegacyWebSearchConfig as r, applyPluginDoctorCompatibilityMigrations as s, findDoctorLegacyConfigIssues as t };
