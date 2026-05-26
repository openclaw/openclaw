import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as DEFAULT_GATEWAY_PORT } from "./paths-Cw7f9XhU.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { r as isModelThinkingFormat } from "./types.models-lqH0KLkn.js";
import { t as loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader-B6ofplrA.js";
import { t as isSafeExecutableValue } from "./exec-safety-1iu4aOkR.js";
import { i as resolveOpenClawMcpTransportAlias, n as isKnownCliMcpTypeAlias } from "./mcp-config-normalize-GXslRjiB.js";
import { o as listLegacyRuntimeModelProviderAliases } from "./model-runtime-aliases-D35Lx2no.js";
import { a as resolveGatewayPortWithDefault, i as isGatewayNonLoopbackBindMode, r as hasConfiguredControlUiAllowedOrigins, t as buildDefaultControlUiAllowedOrigins } from "./gateway-control-ui-origins-BX09k5CR.js";
import { n as ensureRecord$2, r as hasOwnKey$1, t as cloneRecord$1 } from "./legacy-config-record-shared-CpOX8vW0.js";
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
function cleanupEmptyRecord(parent, key) {
	const value = getRecord(parent[key]);
	if (value && Object.keys(value).length === 0) delete parent[key];
}
function resolveCompatibleDefaultGroupEntry(section) {
	const existingGroups = section.groups;
	if (existingGroups !== void 0 && !getRecord(existingGroups)) return null;
	const groups = getRecord(existingGroups) ?? {};
	const existingEntry = groups["*"];
	if (existingEntry !== void 0 && !getRecord(existingEntry)) return null;
	return {
		groups,
		entry: getRecord(existingEntry) ?? {}
	};
}
function migrateChannelDefaultRequireMention(params) {
	const defaultGroupEntry = resolveCompatibleDefaultGroupEntry(params.section);
	if (!defaultGroupEntry) {
		params.changes.push(`Removed ${params.legacyPath} (channels.${params.channelId}.groups has an incompatible shape; fix remaining issues manually).`);
		return false;
	}
	const { groups, entry } = defaultGroupEntry;
	if (entry.requireMention === void 0) {
		entry.requireMention = params.requireMention;
		groups["*"] = entry;
		params.section.groups = groups;
		params.changes.push(`Moved ${params.legacyPath} → channels.${params.channelId}.groups."*".requireMention.`);
		return true;
	}
	params.changes.push(`Removed ${params.legacyPath} (channels.${params.channelId}.groups."*" already set).`);
	return false;
}
function migrateRoutingAllowFrom(raw, changes) {
	const routing = getRecord(raw.routing);
	if (!routing || routing.allowFrom === void 0) return;
	const channels = getRecord(raw.channels);
	const whatsapp = getRecord(channels?.whatsapp);
	if (!channels || !whatsapp) {
		delete routing.allowFrom;
		cleanupEmptyRecord(raw, "routing");
		changes.push("Removed routing.allowFrom (channels.whatsapp not configured).");
		return;
	}
	if (whatsapp.allowFrom === void 0) {
		whatsapp.allowFrom = routing.allowFrom;
		changes.push("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
	} else changes.push("Removed routing.allowFrom (channels.whatsapp.allowFrom already set).");
	delete routing.allowFrom;
	channels.whatsapp = whatsapp;
	raw.channels = channels;
	cleanupEmptyRecord(raw, "routing");
}
function migrateRoutingGroupChatMessages(params) {
	const migrateMessageGroupField = (field) => {
		const value = params.groupChat[field];
		if (value === void 0) return;
		const messagesGroup = ensureRecord$1(ensureRecord$1(params.raw, "messages"), "groupChat");
		if (messagesGroup[field] === void 0) {
			messagesGroup[field] = value;
			params.changes.push(`Moved routing.groupChat.${field} → messages.groupChat.${field}.`);
		} else params.changes.push(`Removed routing.groupChat.${field} (messages.groupChat.${field} already set).`);
		delete params.groupChat[field];
	};
	migrateMessageGroupField("historyLimit");
	migrateMessageGroupField("mentionPatterns");
	if (Object.keys(params.groupChat).length === 0) delete params.routing.groupChat;
	else params.routing.groupChat = params.groupChat;
}
function migrateRoutingGroupChatRequireMention(params) {
	const requireMention = params.groupChat.requireMention;
	if (requireMention === void 0) return;
	const channels = getRecord(params.raw.channels);
	let matchedChannel = false;
	if (channels) {
		for (const channelId of [
			"whatsapp",
			"telegram",
			"imessage"
		]) {
			const section = getRecord(channels[channelId]);
			if (!section) continue;
			matchedChannel = true;
			migrateChannelDefaultRequireMention({
				section,
				channelId,
				legacyPath: "routing.groupChat.requireMention",
				requireMention,
				changes: params.changes
			});
			channels[channelId] = section;
		}
		params.raw.channels = channels;
	}
	if (!matchedChannel) params.changes.push("Removed routing.groupChat.requireMention (no configured WhatsApp, Telegram, or iMessage channel found).");
	delete params.groupChat.requireMention;
}
function migrateRoutingGroupChat(raw, changes) {
	const routing = getRecord(raw.routing);
	const groupChat = getRecord(routing?.groupChat);
	if (!routing || !groupChat) return;
	migrateRoutingGroupChatRequireMention({
		raw,
		groupChat,
		changes
	});
	migrateRoutingGroupChatMessages({
		raw,
		routing,
		groupChat,
		changes
	});
	cleanupEmptyRecord(raw, "routing");
}
function migrateTelegramRequireMention(raw, changes) {
	const channels = getRecord(raw.channels);
	const telegram = getRecord(channels?.telegram);
	if (!channels || !telegram || telegram.requireMention === void 0) return;
	migrateChannelDefaultRequireMention({
		section: telegram,
		channelId: "telegram",
		legacyPath: "channels.telegram.requireMention",
		requireMention: telegram.requireMention,
		changes
	});
	delete telegram.requireMention;
	channels.telegram = telegram;
	raw.channels = channels;
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
	id: "legacy-group-routing->channel-groups",
	describe: "Move legacy routing group chat settings to current channel group and messages config",
	legacyRules: [
		{
			path: ["routing", "allowFrom"],
			message: "routing.allowFrom was removed; use channels.whatsapp.allowFrom instead. Run \"openclaw doctor --fix\"."
		},
		{
			path: [
				"routing",
				"groupChat",
				"requireMention"
			],
			message: "routing.groupChat.requireMention was removed; use channels.<channel>.groups.\"*\".requireMention instead. Run \"openclaw doctor --fix\"."
		},
		{
			path: [
				"routing",
				"groupChat",
				"historyLimit"
			],
			message: "routing.groupChat.historyLimit was moved; use messages.groupChat.historyLimit instead. Run \"openclaw doctor --fix\"."
		},
		{
			path: [
				"routing",
				"groupChat",
				"mentionPatterns"
			],
			message: "routing.groupChat.mentionPatterns was moved; use messages.groupChat.mentionPatterns instead. Run \"openclaw doctor --fix\"."
		},
		{
			path: [
				"channels",
				"telegram",
				"requireMention"
			],
			message: "channels.telegram.requireMention was removed; use channels.telegram.groups.\"*\".requireMention instead. Run \"openclaw doctor --fix\"."
		}
	],
	apply: (raw, changes) => {
		migrateRoutingAllowFrom(raw, changes);
		migrateRoutingGroupChat(raw, changes);
		migrateTelegramRequireMention(raw, changes);
	}
}), defineLegacyConfigMigration({
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
//#region src/commands/doctor/shared/legacy-config-migrations.queue.ts
const RETIRED_QUEUE_MODES = new Set([
	"queue",
	"steer-backlog",
	"steer+backlog"
]);
function isRetiredQueueMode(value) {
	return typeof value === "string" && RETIRED_QUEUE_MODES.has(value);
}
function hasRetiredQueueModeByChannel(value) {
	const byChannel = getRecord(value);
	return Boolean(byChannel && Object.values(byChannel).some(isRetiredQueueMode));
}
function migrateQueueMode(params) {
	const value = params.owner[params.key];
	if (!isRetiredQueueMode(value)) return false;
	const replacement = value === "queue" ? "steer" : "followup";
	params.owner[params.key] = replacement;
	params.changes.push(`Moved deprecated ${params.path} "${value}" → "${replacement}"; use "steer" for default active-run steering.`);
	return true;
}
const LEGACY_CONFIG_MIGRATIONS_QUEUE = [defineLegacyConfigMigration({
	id: "messages.queue.retired-steering-modes",
	describe: "Move retired messages.queue modes to followup mode",
	legacyRules: [{
		path: [
			"messages",
			"queue",
			"mode"
		],
		message: "messages.queue.mode uses a retired queue mode; use steer, followup, collect, or interrupt. Run \"openclaw doctor --fix\".",
		match: isRetiredQueueMode
	}, {
		path: [
			"messages",
			"queue",
			"byChannel"
		],
		message: "messages.queue.byChannel contains a retired queue mode; use steer, followup, collect, or interrupt. Run \"openclaw doctor --fix\".",
		match: hasRetiredQueueModeByChannel
	}],
	apply: (raw, changes) => {
		const queue = getRecord(getRecord(raw.messages)?.queue);
		if (!queue) return;
		migrateQueueMode({
			owner: queue,
			key: "mode",
			path: "messages.queue.mode",
			changes
		});
		const byChannel = getRecord(queue.byChannel);
		if (byChannel) {
			for (const [channelId, _value] of Object.entries(byChannel)) migrateQueueMode({
				owner: byChannel,
				key: channelId,
				path: `messages.queue.byChannel.${channelId}`,
				changes
			});
			queue.byChannel = byChannel;
		}
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
const LEGACY_AGENT_RUNTIME_POLICY_RULES = [
	{
		path: [
			"agents",
			"defaults",
			"agentRuntime",
			"fallback"
		],
		message: "agents.defaults.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run \"openclaw doctor --fix\"."
	},
	{
		path: [
			"agents",
			"defaults",
			"embeddedHarness"
		],
		message: "agents.defaults.embeddedHarness is legacy and ignored; set provider/model runtime policy instead. Run \"openclaw doctor --fix\".",
		match: (value) => getRecord(value) !== null
	},
	{
		path: [
			"agents",
			"defaults",
			"agentRuntime"
		],
		message: "agents.defaults.agentRuntime is ignored; set models.providers.<provider>.agentRuntime or a model-scoped agentRuntime instead. Run \"openclaw doctor --fix\".",
		match: (value) => getRecord(value) !== null
	},
	{
		path: ["agents", "list"],
		message: "agents.list[].agentRuntime is ignored; set provider/model runtime policy instead. Run \"openclaw doctor --fix\".",
		match: (value) => hasAgentListRuntimePolicy(value)
	},
	{
		path: ["agents", "list"],
		message: "agents.list[].embeddedHarness is legacy and ignored; set provider/model runtime policy instead. Run \"openclaw doctor --fix\".",
		match: (value) => hasLegacyAgentListEmbeddedHarness(value)
	}
];
const LEGACY_AGENT_LLM_TIMEOUT_RULES = [{
	path: [
		"agents",
		"defaults",
		"llm"
	],
	message: "agents.defaults.llm is legacy; use models.providers.<id>.timeoutSeconds for slow model/provider timeouts. Run \"openclaw doctor --fix\".",
	match: (value) => getRecord(value) !== null
}];
const IGNORED_AGENT_MODEL_TIMEOUT_RULES = [
	{
		path: [
			"agents",
			"defaults",
			"model"
		],
		message: "agents.defaults.model.timeoutMs is ignored; agent model config only selects primary/fallback models. Run \"openclaw doctor --fix\" to remove it.",
		match: (value) => hasOwnTimeoutMs(value)
	},
	{
		path: [
			"agents",
			"defaults",
			"subagents",
			"model"
		],
		message: "agents.defaults.subagents.model.timeoutMs is ignored; subagent model config only selects primary/fallback models. Run \"openclaw doctor --fix\" to remove it.",
		match: (value) => hasOwnTimeoutMs(value)
	},
	{
		path: ["agents", "list"],
		message: "agents.list[].model.timeoutMs and agents.list[].subagents.model.timeoutMs are ignored; agent model config only selects primary/fallback models. Run \"openclaw doctor --fix\" to remove them.",
		match: (value) => hasAgentListModelTimeout(value)
	}
];
const SILENT_REPLY_LEGACY_RULES = [
	{
		path: [
			"agents",
			"defaults",
			"silentReplyRewrite"
		],
		message: "agents.defaults.silentReplyRewrite was removed; exact NO_REPLY is no longer rewritten to visible fallback text. Run \"openclaw doctor --fix\" to remove it."
	},
	{
		path: [
			"agents",
			"defaults",
			"silentReply"
		],
		message: "agents.defaults.silentReply.direct was removed; direct chats never receive NO_REPLY prompt guidance. Run \"openclaw doctor --fix\" to remove it.",
		match: (value) => Object.prototype.hasOwnProperty.call(getRecord(value) ?? {}, "direct")
	},
	{
		path: ["surfaces"],
		message: "surfaces.*.silentReplyRewrite was removed; exact NO_REPLY is no longer rewritten to visible fallback text. Run \"openclaw doctor --fix\" to remove it.",
		match: (value) => hasSurfaceSilentReplyRewrite(value)
	},
	{
		path: ["surfaces"],
		message: "surfaces.*.silentReply.direct was removed; direct chats never receive NO_REPLY prompt guidance. Run \"openclaw doctor --fix\" to remove it.",
		match: (value) => hasSurfaceSilentReplyDirect(value)
	}
];
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
function hasAgentListRuntimePolicy(value) {
	if (!Array.isArray(value)) return false;
	return value.some((agent) => getRecord(getRecord(agent)?.agentRuntime) !== null);
}
function hasOwnTimeoutMs(value) {
	const record = getRecord(value);
	return Boolean(record && Object.prototype.hasOwnProperty.call(record, "timeoutMs"));
}
function hasAgentListModelTimeout(value) {
	if (!Array.isArray(value)) return false;
	return value.some((agent) => {
		const agentRecord = getRecord(agent);
		return hasOwnTimeoutMs(agentRecord?.model) || hasOwnTimeoutMs(getRecord(agentRecord?.subagents)?.model);
	});
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
function removeLegacyAgentRuntimePolicy(container, pathLabel, changes) {
	if (getRecord(container.embeddedHarness) !== null) {
		delete container.embeddedHarness;
		changes.push(`Removed ${pathLabel}.embeddedHarness; runtime is now provider/model scoped.`);
	}
	if (getRecord(container.agentRuntime) !== null) {
		preserveLegacyWholeAgentRuntimePolicy(container, pathLabel, changes);
		delete container.agentRuntime;
		changes.push(`Removed ${pathLabel}.agentRuntime; runtime is now provider/model scoped.`);
	}
}
function resolveLegacyAgentRuntimeIntent(raw) {
	const record = getRecord(raw);
	if (!record) return;
	const runtime = typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
	if (!runtime || runtime === "auto" || runtime === "pi") return;
	const alias = listLegacyRuntimeModelProviderAliases().find((entry) => entry.cli && normalizeProviderId(entry.runtime) === runtime);
	return alias ? {
		provider: alias.provider,
		runtime: alias.runtime
	} : void 0;
}
function selectedCanonicalModelRefsForRuntimePolicy(rawModel, provider) {
	const refs = [];
	const addRef = (rawRef) => {
		if (typeof rawRef !== "string") return;
		const trimmed = rawRef.trim();
		const slash = trimmed.indexOf("/");
		if (slash <= 0 || slash >= trimmed.length - 1) return;
		if (normalizeProviderId(trimmed.slice(0, slash)) !== normalizeProviderId(provider)) return;
		refs.push(trimmed);
	};
	if (typeof rawModel === "string") {
		addRef(rawModel);
		return refs;
	}
	const model = getRecord(rawModel);
	if (!model) return refs;
	addRef(model.primary);
	if (Array.isArray(model.fallbacks)) for (const fallback of model.fallbacks) addRef(fallback);
	return refs;
}
function modelEntryWithRuntimePolicy(entry, runtime) {
	const base = getRecord(entry) ? { ...entry } : {};
	const currentRuntime = getRecord(base.agentRuntime);
	const currentRuntimeId = typeof currentRuntime?.id === "string" ? currentRuntime.id.trim().toLowerCase() : "";
	if (currentRuntimeId && currentRuntimeId !== "auto") return {
		changed: false,
		entry: base
	};
	base.agentRuntime = {
		...currentRuntime,
		id: runtime
	};
	return {
		changed: true,
		entry: base
	};
}
function preserveLegacyWholeAgentRuntimePolicy(container, pathLabel, changes) {
	const intent = resolveLegacyAgentRuntimeIntent(container.agentRuntime);
	if (!intent) return;
	const selectedRefs = selectedCanonicalModelRefsForRuntimePolicy(container.model, intent.provider);
	if (selectedRefs.length === 0) return;
	const currentModels = getRecord(container.models);
	const nextModels = currentModels ? { ...currentModels } : {};
	let changed = false;
	for (const ref of selectedRefs) {
		const updated = modelEntryWithRuntimePolicy(nextModels[ref], intent.runtime);
		if (!updated.changed) continue;
		nextModels[ref] = updated.entry;
		changed = true;
	}
	if (!changed) return;
	container.models = nextModels;
	changes.push(`Moved ${pathLabel}.agentRuntime.id ${intent.runtime} to matching ${intent.provider} model runtime policy.`);
}
function removeIgnoredAgentModelTimeout(model, pathLabel, changes) {
	const modelRecord = getRecord(model);
	if (!modelRecord || !Object.prototype.hasOwnProperty.call(modelRecord, "timeoutMs")) return;
	delete modelRecord.timeoutMs;
	changes.push(`Removed ${pathLabel}.timeoutMs; agent model config only selects models.`);
}
function hasOwnRecordProperty(value, key) {
	const record = getRecord(value);
	return Boolean(record && Object.prototype.hasOwnProperty.call(record, key));
}
function hasSurfaceSilentReplyRewrite(value) {
	const surfaces = getRecord(value);
	if (!surfaces) return false;
	return Object.entries(surfaces).some(([surfaceId, surface]) => !isBlockedObjectKey(surfaceId) && hasOwnRecordProperty(surface, "silentReplyRewrite"));
}
function hasSurfaceSilentReplyDirect(value) {
	const surfaces = getRecord(value);
	if (!surfaces) return false;
	return Object.values(surfaces).some((surface) => Object.prototype.hasOwnProperty.call(getRecord(getRecord(surface)?.silentReply) ?? {}, "direct"));
}
function removeLegacySilentReplyConfig(raw, changes) {
	const defaults = getRecord(getRecord(raw.agents)?.defaults);
	const defaultSilentReply = getRecord(defaults?.silentReply);
	if (defaultSilentReply && Object.prototype.hasOwnProperty.call(defaultSilentReply, "direct")) {
		delete defaultSilentReply.direct;
		changes.push("Removed agents.defaults.silentReply.direct; direct chats never use NO_REPLY.");
	}
	if (defaults && hasOwnRecordProperty(defaults, "silentReplyRewrite")) {
		delete defaults.silentReplyRewrite;
		changes.push("Removed agents.defaults.silentReplyRewrite.");
	}
	const surfaces = getRecord(raw.surfaces);
	if (!surfaces) return;
	for (const [surfaceId, surfaceValue] of Object.entries(surfaces)) {
		if (isBlockedObjectKey(surfaceId)) continue;
		const surface = getRecord(surfaceValue);
		if (!surface) continue;
		const silentReply = getRecord(surface.silentReply);
		if (silentReply && Object.prototype.hasOwnProperty.call(silentReply, "direct")) {
			delete silentReply.direct;
			changes.push(`Removed surfaces.${surfaceId}.silentReply.direct; direct chats never use NO_REPLY.`);
		}
		if (hasOwnRecordProperty(surface, "silentReplyRewrite")) {
			delete surface.silentReplyRewrite;
			changes.push(`Removed surfaces.${surfaceId}.silentReplyRewrite.`);
		}
	}
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS = [
	defineLegacyConfigMigration({
		id: "silentReplyRewrite-removed",
		describe: "Remove legacy silent reply rewrite and direct-chat silent reply config",
		legacyRules: SILENT_REPLY_LEGACY_RULES,
		apply: removeLegacySilentReplyConfig
	}),
	defineLegacyConfigMigration({
		id: "agents.defaults.llm->models.providers.timeoutSeconds",
		describe: "Remove legacy agents.defaults.llm timeout config",
		legacyRules: LEGACY_AGENT_LLM_TIMEOUT_RULES,
		apply: (raw, changes) => {
			const defaults = getRecord(getRecord(raw.agents)?.defaults);
			if (!defaults || getRecord(defaults.llm) === null) return;
			delete defaults.llm;
			changes.push("Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds within the agent/run timeout ceiling.");
		}
	}),
	defineLegacyConfigMigration({
		id: "agents.model.timeoutMs-ignored",
		describe: "Remove ignored timeoutMs keys from agent model selection config",
		legacyRules: IGNORED_AGENT_MODEL_TIMEOUT_RULES,
		apply: (raw, changes) => {
			const agents = getRecord(raw.agents);
			const defaults = getRecord(agents?.defaults);
			if (defaults) {
				removeIgnoredAgentModelTimeout(defaults.model, "agents.defaults.model", changes);
				removeIgnoredAgentModelTimeout(getRecord(defaults.subagents)?.model, "agents.defaults.subagents.model", changes);
			}
			if (!Array.isArray(agents?.list)) return;
			for (const [index, agent] of agents.list.entries()) {
				const agentRecord = getRecord(agent);
				if (!agentRecord) continue;
				removeIgnoredAgentModelTimeout(agentRecord.model, `agents.list.${index}.model`, changes);
				removeIgnoredAgentModelTimeout(getRecord(agentRecord.subagents)?.model, `agents.list.${index}.subagents.model`, changes);
			}
		}
	}),
	defineLegacyConfigMigration({
		id: "agents.agentRuntime-ignored",
		describe: "Remove ignored agent-wide runtime policy",
		legacyRules: LEGACY_AGENT_RUNTIME_POLICY_RULES,
		apply: (raw, changes) => {
			const agents = getRecord(raw.agents);
			const defaults = getRecord(agents?.defaults);
			if (defaults) removeLegacyAgentRuntimePolicy(defaults, "agents.defaults", changes);
			if (!Array.isArray(agents?.list)) return;
			for (const [index, agent] of agents.list.entries()) {
				const agentRecord = getRecord(agent);
				if (!agentRecord) continue;
				removeLegacyAgentRuntimePolicy(agentRecord, `agents.list.${index}`, changes);
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
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.diagnostics.ts
function isLegacyMemoryPressureBundleConfig(value) {
	return typeof value === "boolean" || getRecord(value) !== null;
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS = [defineLegacyConfigMigration({
	id: "diagnostics.memoryPressureBundle->memoryPressureSnapshot",
	describe: "Move diagnostics.memoryPressureBundle to diagnostics.memoryPressureSnapshot",
	legacyRules: [{
		path: ["diagnostics", "memoryPressureBundle"],
		message: "diagnostics.memoryPressureBundle was renamed; use diagnostics.memoryPressureSnapshot instead. Run \"openclaw doctor --fix\".",
		match: isLegacyMemoryPressureBundleConfig,
		requireSourceLiteral: true
	}],
	apply: (raw, changes) => {
		const diagnostics = getRecord(raw.diagnostics);
		if (!diagnostics || !isLegacyMemoryPressureBundleConfig(diagnostics.memoryPressureBundle)) return;
		if (Object.prototype.hasOwnProperty.call(diagnostics, "memoryPressureSnapshot")) {
			delete diagnostics.memoryPressureBundle;
			changes.push("Removed diagnostics.memoryPressureBundle (memoryPressureSnapshot already set).");
			return;
		}
		const legacy = getRecord(diagnostics.memoryPressureBundle);
		diagnostics.memoryPressureSnapshot = typeof diagnostics.memoryPressureBundle === "boolean" ? diagnostics.memoryPressureBundle : legacy?.enabled !== false;
		delete diagnostics.memoryPressureBundle;
		changes.push("Moved diagnostics.memoryPressureBundle → memoryPressureSnapshot.");
	}
})];
//#endregion
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.gateway.ts
const GATEWAY_BIND_RULE = {
	path: ["gateway", "bind"],
	message: "gateway.bind host aliases (for example 0.0.0.0/localhost) are legacy; use bind modes (lan/loopback/custom/tailnet/auto) instead. Run \"openclaw doctor --fix\".",
	match: (value) => isLegacyGatewayBindHostAlias(value),
	requireSourceLiteral: true
};
function isLegacyGatewayBindHostAlias(value) {
	return normalizeLegacyGatewayBindHostAlias(value) !== null;
}
function normalizeLegacyGatewayBindHostAlias(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return null;
	if (normalized === "auto" || normalized === "loopback" || normalized === "lan" || normalized === "tailnet" || normalized === "custom") return null;
	if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]" || normalized === "*") return "lan";
	if (normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return "loopback";
	return null;
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
		const bind = normalizeLegacyGatewayBindHostAlias(gateway.bind) ?? gateway.bind;
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
		const mapped = normalizeLegacyGatewayBindHostAlias(bindRaw);
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
//#region src/commands/doctor/shared/legacy-config-migrations.runtime.models.ts
function hasInvalidThinkingFormat(providers) {
	const providersRecord = getRecord(providers);
	if (!providersRecord) return false;
	for (const provider of Object.values(providersRecord)) {
		const models = getRecord(provider)?.models;
		if (!Array.isArray(models)) continue;
		for (const model of models) {
			const thinkingFormat = getRecord(getRecord(model)?.compat)?.thinkingFormat;
			if (typeof thinkingFormat === "string" && !isModelThinkingFormat(thinkingFormat)) return true;
		}
	}
	return false;
}
const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS = [defineLegacyConfigMigration({
	id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
	describe: "Remove unrecognized compat.thinkingFormat values from provider model entries",
	legacyRules: [{
		path: ["models", "providers"],
		message: "models.providers.<id>.models[*].compat.thinkingFormat has an unrecognized value; run \"openclaw doctor --fix\" to remove it and restore the runtime default.",
		match: (value) => hasInvalidThinkingFormat(value)
	}],
	apply: (raw, changes) => {
		const providers = getRecord(getRecord(raw.models)?.providers);
		if (!providers) return;
		for (const [providerId, provider] of Object.entries(providers)) {
			const models = getRecord(provider)?.models;
			if (!Array.isArray(models)) continue;
			for (const [index, model] of models.entries()) {
				const compat = getRecord(getRecord(model)?.compat);
				if (!compat) continue;
				const thinkingFormat = compat.thinkingFormat;
				if (typeof thinkingFormat !== "string" || isModelThinkingFormat(thinkingFormat)) continue;
				delete compat.thinkingFormat;
				changes.push(`Removed models.providers.${providerId}.models.${index}.compat.thinkingFormat (unrecognized value ${JSON.stringify(thinkingFormat)}; runtime default applies).`);
			}
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
	id: "plugins.allow->plugins.bundledDiscovery.compat",
	describe: "Preserve legacy bundled provider discovery for existing restrictive allowlists",
	legacyRules: [{
		path: ["plugins", "allow"],
		message: "plugins.allow now gates bundled provider discovery by default; run \"openclaw doctor --fix\" to preserve legacy bundled provider compatibility as plugins.bundledDiscovery=\"compat\", or set plugins.bundledDiscovery=\"allowlist\" to keep the stricter behavior.",
		requireSourceLiteral: true,
		match: (value, root) => {
			if (!Array.isArray(value) || value.length === 0) return false;
			return (isRecord(root.plugins) ? root.plugins : void 0)?.bundledDiscovery === void 0;
		}
	}],
	apply: (raw, changes) => {
		const plugins = isRecord(raw.plugins) ? raw.plugins : void 0;
		if (!plugins || plugins.bundledDiscovery !== void 0) return;
		const allow = plugins.allow;
		if (!Array.isArray(allow) || allow.length === 0) return;
		plugins.bundledDiscovery = "compat";
		changes.push("Set plugins.bundledDiscovery=\"compat\" to preserve legacy bundled provider discovery for this restrictive plugins.allow config.");
	}
}), defineLegacyConfigMigration({
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
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS
];
//#endregion
//#region src/commands/doctor/shared/legacy-web-search-migrate.ts
const DANGEROUS_RECORD_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
const BUNDLED_LEGACY_WEB_SEARCH_OWNERS = new Map([
	["brave", "brave"],
	["duckduckgo", "duckduckgo"],
	["exa", "exa"],
	["firecrawl", "firecrawl"],
	["gemini", "google"],
	["grok", "xai"],
	["kimi", "moonshot"],
	["minimax", "minimax"],
	["ollama", "ollama"],
	["perplexity", "perplexity"],
	["searxng", "searxng"],
	["tavily", "tavily"]
]);
const NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS = new Set(["tavily"]);
const LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID = "brave";
function getBundledLegacyWebSearchOwners() {
	return BUNDLED_LEGACY_WEB_SEARCH_OWNERS;
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
		if (DANGEROUS_RECORD_KEYS.has(key)) continue;
		nextSearch[key] = value;
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
	...LEGACY_CONFIG_MIGRATIONS_QUEUE,
	...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
	...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH
];
const LEGACY_CONFIG_MIGRATIONS = LEGACY_CONFIG_MIGRATION_SPECS.map(({ legacyRules: _legacyRules, ...migration }) => migration);
const LEGACY_CONFIG_MIGRATION_RULES = LEGACY_CONFIG_MIGRATION_SPECS.flatMap((migration) => migration.legacyRules ?? []);
//#endregion
export { mergeMissing as a, migrateLegacyXSearchConfig as i, LEGACY_CONFIG_MIGRATION_RULES as n, loadBundledChannelDoctorContractApi as o, migrateLegacyWebSearchConfig as r, LEGACY_CONFIG_MIGRATIONS as t };
