import { D as getChatChannelMeta, P as requireActivePluginRegistry, Z as escapeRegExp, nt as normalizeE164, w as CHAT_CHANNEL_ORDER } from "./entry.js";
import { h as normalizeAccountId } from "./session-key-qmb11-mH.js";
import { t as resolveAccountEntry } from "./account-lookup-DndUerpe.js";
import { C as resolveDiscordAccount, d as resolveTelegramAccount, g as resolveSlackReplyToMode, h as resolveSlackAccount, o as normalizeWhatsAppTarget } from "./plugins-BOmV0yTv.js";
import { i as resolveWhatsAppAccount } from "./accounts-jTTYYc3C.js";
import { r as resolveIMessageAccount } from "./accounts-CnxuiQaw.js";
import { i as resolveSignalAccount } from "./accounts-DKgW2m_s.js";

//#region src/config/types.tools.ts
const TOOLS_BY_SENDER_KEY_TYPES = [
	"id",
	"e164",
	"username",
	"name"
];
function parseToolsBySenderTypedKey(rawKey) {
	const trimmed = rawKey.trim();
	if (!trimmed) return;
	const lowered = trimmed.toLowerCase();
	for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
		const prefix = `${type}:`;
		if (!lowered.startsWith(prefix)) continue;
		return {
			type,
			value: trimmed.slice(prefix.length)
		};
	}
}

//#endregion
//#region src/shared/string-normalization.ts
function normalizeStringEntries(list) {
	return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}
function normalizeStringEntriesLower(list) {
	return normalizeStringEntries(list).map((entry) => entry.toLowerCase());
}
function normalizeHyphenSlug(raw) {
	const trimmed = raw?.trim().toLowerCase() ?? "";
	if (!trimmed) return "";
	return trimmed.replace(/\s+/g, "-").replace(/[^a-z0-9#@._+-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}
function normalizeAtHashSlug(raw) {
	const trimmed = raw?.trim().toLowerCase() ?? "";
	if (!trimmed) return "";
	return trimmed.replace(/^[@#]+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

//#endregion
//#region src/config/group-policy.ts
function resolveChannelGroupConfig(groups, groupId, caseInsensitive = false) {
	if (!groups) return;
	const direct = groups[groupId];
	if (direct) return direct;
	if (!caseInsensitive) return;
	const target = groupId.toLowerCase();
	const matchedKey = Object.keys(groups).find((key) => key !== "*" && key.toLowerCase() === target);
	if (!matchedKey) return;
	return groups[matchedKey];
}
const warnedLegacyToolsBySenderKeys = /* @__PURE__ */ new Set();
const compiledToolsBySenderCache = /* @__PURE__ */ new WeakMap();
function normalizeSenderKey(value, options = {}) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return (options.stripLeadingAt && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed).toLowerCase();
}
function normalizeTypedSenderKey(value, type) {
	return normalizeSenderKey(value, { stripLeadingAt: type === "username" });
}
function normalizeLegacySenderKey(value) {
	return normalizeSenderKey(value, { stripLeadingAt: true });
}
function warnLegacyToolsBySenderKey(rawKey) {
	const trimmed = rawKey.trim();
	if (!trimmed || warnedLegacyToolsBySenderKeys.has(trimmed)) return;
	warnedLegacyToolsBySenderKeys.add(trimmed);
	process.emitWarning(`toolsBySender key "${trimmed}" is deprecated. Use explicit prefixes (id:, e164:, username:, name:). Legacy unprefixed keys are matched as id only.`, {
		type: "DeprecationWarning",
		code: "OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY"
	});
}
function parseSenderPolicyKey(rawKey) {
	const trimmed = rawKey.trim();
	if (!trimmed) return;
	if (trimmed === "*") return { kind: "wildcard" };
	const typed = parseToolsBySenderTypedKey(trimmed);
	if (typed) {
		const key = normalizeTypedSenderKey(typed.value, typed.type);
		if (!key) return;
		return {
			kind: "typed",
			type: typed.type,
			key
		};
	}
	warnLegacyToolsBySenderKey(trimmed);
	const key = normalizeLegacySenderKey(trimmed);
	if (!key) return;
	return {
		kind: "typed",
		type: "id",
		key
	};
}
function createSenderPolicyBuckets() {
	return {
		id: /* @__PURE__ */ new Map(),
		e164: /* @__PURE__ */ new Map(),
		username: /* @__PURE__ */ new Map(),
		name: /* @__PURE__ */ new Map()
	};
}
function compileToolsBySenderPolicy(toolsBySender) {
	const entries = Object.entries(toolsBySender);
	if (entries.length === 0) return;
	const buckets = createSenderPolicyBuckets();
	let wildcard;
	for (const [rawKey, policy] of entries) {
		if (!policy) continue;
		const parsed = parseSenderPolicyKey(rawKey);
		if (!parsed) continue;
		if (parsed.kind === "wildcard") {
			wildcard = policy;
			continue;
		}
		const bucket = buckets[parsed.type];
		if (!bucket.has(parsed.key)) bucket.set(parsed.key, policy);
	}
	return {
		buckets,
		wildcard
	};
}
function resolveCompiledToolsBySenderPolicy(toolsBySender) {
	const cached = compiledToolsBySenderCache.get(toolsBySender);
	if (cached) return cached;
	const compiled = compileToolsBySenderPolicy(toolsBySender);
	if (!compiled) return;
	compiledToolsBySenderCache.set(toolsBySender, compiled);
	return compiled;
}
function normalizeCandidate(value, type) {
	const trimmed = value?.trim();
	if (!trimmed) return "";
	return normalizeTypedSenderKey(trimmed, type);
}
function normalizeSenderIdCandidates(value) {
	const trimmed = value?.trim();
	if (!trimmed) return [];
	const typed = normalizeTypedSenderKey(trimmed, "id");
	const legacy = normalizeLegacySenderKey(trimmed);
	if (!typed) return legacy ? [legacy] : [];
	if (!legacy || legacy === typed) return [typed];
	return [typed, legacy];
}
function matchToolsBySenderPolicy(compiled, params) {
	for (const senderIdCandidate of normalizeSenderIdCandidates(params.senderId)) {
		const match = compiled.buckets.id.get(senderIdCandidate);
		if (match) return match;
	}
	const senderE164 = normalizeCandidate(params.senderE164, "e164");
	if (senderE164) {
		const match = compiled.buckets.e164.get(senderE164);
		if (match) return match;
	}
	const senderUsername = normalizeCandidate(params.senderUsername, "username");
	if (senderUsername) {
		const match = compiled.buckets.username.get(senderUsername);
		if (match) return match;
	}
	const senderName = normalizeCandidate(params.senderName, "name");
	if (senderName) {
		const match = compiled.buckets.name.get(senderName);
		if (match) return match;
	}
	return compiled.wildcard;
}
function resolveToolsBySender(params) {
	const toolsBySender = params.toolsBySender;
	if (!toolsBySender) return;
	const compiled = resolveCompiledToolsBySenderPolicy(toolsBySender);
	if (!compiled) return;
	return matchToolsBySenderPolicy(compiled, params);
}
function resolveChannelGroups(cfg, channel, accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	const channelConfig = cfg.channels?.[channel];
	if (!channelConfig) return;
	return resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groups ?? channelConfig.groups;
}
function resolveChannelGroupPolicyMode(cfg, channel, accountId) {
	const normalizedAccountId = normalizeAccountId(accountId);
	const channelConfig = cfg.channels?.[channel];
	if (!channelConfig) return;
	return resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groupPolicy ?? channelConfig.groupPolicy;
}
function resolveChannelGroupPolicy(params) {
	const { cfg, channel } = params;
	const groups = resolveChannelGroups(cfg, channel, params.accountId);
	const groupPolicy = resolveChannelGroupPolicyMode(cfg, channel, params.accountId);
	const hasGroups = Boolean(groups && Object.keys(groups).length > 0);
	const allowlistEnabled = groupPolicy === "allowlist" || hasGroups;
	const normalizedId = params.groupId?.trim();
	const groupConfig = normalizedId ? resolveChannelGroupConfig(groups, normalizedId, params.groupIdCaseInsensitive) : void 0;
	const defaultConfig = groups?.["*"];
	const allowAll = allowlistEnabled && Boolean(groups && Object.hasOwn(groups, "*"));
	const senderFilterBypass = groupPolicy === "allowlist" && !hasGroups && Boolean(params.hasGroupAllowFrom);
	return {
		allowlistEnabled,
		allowed: groupPolicy === "disabled" ? false : !allowlistEnabled || allowAll || Boolean(groupConfig) || senderFilterBypass,
		groupConfig,
		defaultConfig
	};
}
function resolveChannelGroupRequireMention(params) {
	const { requireMentionOverride, overrideOrder = "after-config" } = params;
	const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
	const configMention = typeof groupConfig?.requireMention === "boolean" ? groupConfig.requireMention : typeof defaultConfig?.requireMention === "boolean" ? defaultConfig.requireMention : void 0;
	if (overrideOrder === "before-config" && typeof requireMentionOverride === "boolean") return requireMentionOverride;
	if (typeof configMention === "boolean") return configMention;
	if (overrideOrder !== "before-config" && typeof requireMentionOverride === "boolean") return requireMentionOverride;
	return true;
}
function resolveChannelGroupToolsPolicy(params) {
	const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
	const groupSenderPolicy = resolveToolsBySender({
		toolsBySender: groupConfig?.toolsBySender,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	if (groupSenderPolicy) return groupSenderPolicy;
	if (groupConfig?.tools) return groupConfig.tools;
	const defaultSenderPolicy = resolveToolsBySender({
		toolsBySender: defaultConfig?.toolsBySender,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	if (defaultSenderPolicy) return defaultSenderPolicy;
	if (defaultConfig?.tools) return defaultConfig.tools;
}

//#endregion
//#region src/slack/threading-tool-context.ts
function buildSlackThreadingToolContext(params) {
	const configuredReplyToMode = resolveSlackReplyToMode(resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}), params.context.ChatType);
	const effectiveReplyToMode = params.context.ThreadLabel ? "all" : configuredReplyToMode;
	const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
	return {
		currentChannelId: params.context.To?.startsWith("channel:") ? params.context.To.slice(8) : void 0,
		currentThreadTs: threadId != null ? String(threadId) : void 0,
		replyToMode: effectiveReplyToMode,
		hasRepliedRef: params.hasRepliedRef
	};
}

//#endregion
//#region src/channels/plugins/group-mentions.ts
function normalizeDiscordSlug(value) {
	return normalizeAtHashSlug(value);
}
function parseTelegramGroupId(value) {
	const raw = value?.trim() ?? "";
	if (!raw) return {
		chatId: void 0,
		topicId: void 0
	};
	const parts = raw.split(":").filter(Boolean);
	if (parts.length >= 3 && parts[1] === "topic" && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[2])) return {
		chatId: parts[0],
		topicId: parts[2]
	};
	if (parts.length >= 2 && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) return {
		chatId: parts[0],
		topicId: parts[1]
	};
	return {
		chatId: raw,
		topicId: void 0
	};
}
function resolveTelegramRequireMention(params) {
	const { cfg, chatId, topicId } = params;
	if (!chatId) return;
	const groupConfig = cfg.channels?.telegram?.groups?.[chatId];
	const groupDefault = cfg.channels?.telegram?.groups?.["*"];
	const topicConfig = topicId && groupConfig?.topics ? groupConfig.topics[topicId] : void 0;
	const defaultTopicConfig = topicId && groupDefault?.topics ? groupDefault.topics[topicId] : void 0;
	if (typeof topicConfig?.requireMention === "boolean") return topicConfig.requireMention;
	if (typeof defaultTopicConfig?.requireMention === "boolean") return defaultTopicConfig.requireMention;
	if (typeof groupConfig?.requireMention === "boolean") return groupConfig.requireMention;
	if (typeof groupDefault?.requireMention === "boolean") return groupDefault.requireMention;
}
function resolveDiscordGuildEntry(guilds, groupSpace) {
	if (!guilds || Object.keys(guilds).length === 0) return null;
	const space = groupSpace?.trim() ?? "";
	if (space && guilds[space]) return guilds[space];
	const normalized = normalizeDiscordSlug(space);
	if (normalized && guilds[normalized]) return guilds[normalized];
	if (normalized) {
		const match = Object.values(guilds).find((entry) => normalizeDiscordSlug(entry?.slug ?? void 0) === normalized);
		if (match) return match;
	}
	return guilds["*"] ?? null;
}
function resolveDiscordChannelEntry(channelEntries, params) {
	if (!channelEntries || Object.keys(channelEntries).length === 0) return;
	const groupChannel = params.groupChannel;
	const channelSlug = normalizeDiscordSlug(groupChannel);
	return (params.groupId ? channelEntries[params.groupId] : void 0) ?? (channelSlug ? channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`] : void 0) ?? (groupChannel ? channelEntries[normalizeDiscordSlug(groupChannel)] : void 0);
}
function resolveSlackChannelPolicyEntry(params) {
	const channels = resolveSlackAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).channels ?? {};
	if (Object.keys(channels).length === 0) return;
	const channelId = params.groupId?.trim();
	const channelName = params.groupChannel?.replace(/^#/, "");
	const normalizedName = normalizeHyphenSlug(channelName);
	const candidates = [
		channelId ?? "",
		channelName ? `#${channelName}` : "",
		channelName ?? "",
		normalizedName
	].filter(Boolean);
	for (const candidate of candidates) if (candidate && channels[candidate]) return channels[candidate];
	return channels["*"];
}
function resolveChannelRequireMention(params, channel, groupId = params.groupId) {
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel,
		groupId,
		accountId: params.accountId
	});
}
function resolveChannelToolPolicyForSender(params, channel, groupId = params.groupId) {
	return resolveChannelGroupToolsPolicy({
		cfg: params.cfg,
		channel,
		groupId,
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
}
function resolveSenderToolsEntry(entry, params) {
	if (!entry) return;
	const senderPolicy = resolveToolsBySender({
		toolsBySender: entry.toolsBySender,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	if (senderPolicy) return senderPolicy;
	return entry.tools;
}
function resolveDiscordPolicyContext(params) {
	const guildEntry = resolveDiscordGuildEntry(params.cfg.channels?.discord?.guilds, params.groupSpace);
	const channelEntries = guildEntry?.channels;
	return {
		guildEntry,
		channelEntry: channelEntries && Object.keys(channelEntries).length > 0 ? resolveDiscordChannelEntry(channelEntries, params) : void 0
	};
}
function resolveTelegramGroupRequireMention(params) {
	const { chatId, topicId } = parseTelegramGroupId(params.groupId);
	const requireMention = resolveTelegramRequireMention({
		cfg: params.cfg,
		chatId,
		topicId
	});
	if (typeof requireMention === "boolean") return requireMention;
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "telegram",
		groupId: chatId ?? params.groupId,
		accountId: params.accountId
	});
}
function resolveWhatsAppGroupRequireMention(params) {
	return resolveChannelRequireMention(params, "whatsapp");
}
function resolveIMessageGroupRequireMention(params) {
	return resolveChannelRequireMention(params, "imessage");
}
function resolveDiscordGroupRequireMention(params) {
	const context = resolveDiscordPolicyContext(params);
	if (typeof context.channelEntry?.requireMention === "boolean") return context.channelEntry.requireMention;
	if (typeof context.guildEntry?.requireMention === "boolean") return context.guildEntry.requireMention;
	return true;
}
function resolveGoogleChatGroupRequireMention(params) {
	return resolveChannelRequireMention(params, "googlechat");
}
function resolveGoogleChatGroupToolPolicy(params) {
	return resolveChannelToolPolicyForSender(params, "googlechat");
}
function resolveSlackGroupRequireMention(params) {
	const resolved = resolveSlackChannelPolicyEntry(params);
	if (typeof resolved?.requireMention === "boolean") return resolved.requireMention;
	return true;
}
function resolveTelegramGroupToolPolicy(params) {
	const { chatId } = parseTelegramGroupId(params.groupId);
	return resolveChannelToolPolicyForSender(params, "telegram", chatId ?? params.groupId);
}
function resolveWhatsAppGroupToolPolicy(params) {
	return resolveChannelToolPolicyForSender(params, "whatsapp");
}
function resolveIMessageGroupToolPolicy(params) {
	return resolveChannelToolPolicyForSender(params, "imessage");
}
function resolveDiscordGroupToolPolicy(params) {
	const context = resolveDiscordPolicyContext(params);
	const channelPolicy = resolveSenderToolsEntry(context.channelEntry, params);
	if (channelPolicy) return channelPolicy;
	return resolveSenderToolsEntry(context.guildEntry, params);
}
function resolveSlackGroupToolPolicy(params) {
	return resolveSenderToolsEntry(resolveSlackChannelPolicyEntry(params), params);
}

//#endregion
//#region src/channels/plugins/normalize/signal.ts
function normalizeSignalMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	let normalized = trimmed;
	if (normalized.toLowerCase().startsWith("signal:")) normalized = normalized.slice(7).trim();
	if (!normalized) return;
	const lower = normalized.toLowerCase();
	if (lower.startsWith("group:")) {
		const id = normalized.slice(6).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("username:")) {
		const id = normalized.slice(9).trim();
		return id ? `username:${id}`.toLowerCase() : void 0;
	}
	if (lower.startsWith("u:")) {
		const id = normalized.slice(2).trim();
		return id ? `username:${id}`.toLowerCase() : void 0;
	}
	if (lower.startsWith("uuid:")) {
		const id = normalized.slice(5).trim();
		return id ? id.toLowerCase() : void 0;
	}
	return normalized.toLowerCase();
}

//#endregion
//#region src/channels/plugins/normalize/whatsapp.ts
function normalizeWhatsAppAllowFromEntries(allowFrom) {
	return allowFrom.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry)).map((entry) => entry === "*" ? entry : normalizeWhatsAppTarget(entry)).filter((entry) => Boolean(entry));
}

//#endregion
//#region src/channels/plugins/whatsapp-shared.ts
const WHATSAPP_GROUP_INTRO_HINT = "WhatsApp IDs: SenderId is the participant JID (group participant id).";
function resolveWhatsAppGroupIntroHint() {
	return WHATSAPP_GROUP_INTRO_HINT;
}
function resolveWhatsAppMentionStripPatterns(ctx) {
	const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
	if (!selfE164) return [];
	const escaped = escapeRegExp(selfE164);
	return [escaped, `@${escaped}`];
}

//#endregion
//#region src/channels/dock.ts
const formatLower = (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => entry.toLowerCase());
const stringifyAllowFrom = (allowFrom) => allowFrom.map((entry) => String(entry));
const trimAllowFromEntries = (allowFrom) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
const DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000 = { textChunkLimit: 4e3 };
const DEFAULT_BLOCK_STREAMING_COALESCE = { blockStreamingCoalesceDefaults: {
	minChars: 1500,
	idleMs: 1e3
} };
function formatAllowFromWithReplacements(allowFrom, replacements) {
	return trimAllowFromEntries(allowFrom).map((entry) => {
		let normalized = entry;
		for (const replacement of replacements) normalized = normalized.replace(replacement, "");
		return normalized.toLowerCase();
	});
}
const formatDiscordAllowFrom = (allowFrom) => allowFrom.map((entry) => String(entry).trim().replace(/^<@!?/, "").replace(/>$/, "").replace(/^discord:/i, "").replace(/^user:/i, "").replace(/^pk:/i, "").trim().toLowerCase()).filter(Boolean);
function resolveDirectOrGroupChannelId(context) {
	return (context.ChatType?.toLowerCase() === "direct" ? context.From ?? context.To : context.To)?.trim() || void 0;
}
function buildSignalThreadToolContext(params) {
	const currentChannelIdRaw = resolveDirectOrGroupChannelId(params.context);
	return {
		currentChannelId: currentChannelIdRaw ? normalizeSignalMessagingTarget(currentChannelIdRaw) ?? currentChannelIdRaw.trim() : void 0,
		currentThreadTs: params.context.ReplyToId,
		hasRepliedRef: params.hasRepliedRef
	};
}
function buildIMessageThreadToolContext(params) {
	return {
		currentChannelId: resolveDirectOrGroupChannelId(params.context),
		currentThreadTs: params.context.ReplyToId,
		hasRepliedRef: params.hasRepliedRef
	};
}
function buildThreadToolContextFromMessageThreadOrReply(params) {
	const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
	return {
		currentChannelId: params.context.To?.trim() || void 0,
		currentThreadTs: threadId != null ? String(threadId) : void 0,
		hasRepliedRef: params.hasRepliedRef
	};
}
function resolveCaseInsensitiveAccount(accounts, accountId) {
	if (!accounts) return;
	const normalized = normalizeAccountId(accountId);
	return accounts[normalized] ?? accounts[Object.keys(accounts).find((key) => key.toLowerCase() === normalized.toLowerCase()) ?? ""];
}
function resolveDefaultToCaseInsensitiveAccount(params) {
	return (resolveCaseInsensitiveAccount(params.channel?.accounts, params.accountId)?.defaultTo ?? params.channel?.defaultTo)?.trim() || void 0;
}
function resolveChannelDefaultTo(channel, accountId) {
	return resolveDefaultToCaseInsensitiveAccount({
		channel,
		accountId
	});
}
function resolveNamedChannelDefaultTo(params) {
	return resolveChannelDefaultTo(params.channels?.[params.channelId], params.accountId);
}
const DOCKS = {
	telegram: {
		id: "telegram",
		capabilities: {
			chatTypes: [
				"direct",
				"group",
				"channel",
				"thread"
			],
			nativeCommands: true,
			blockStreaming: true
		},
		outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => stringifyAllowFrom(resolveTelegramAccount({
				cfg,
				accountId
			}).config.allowFrom ?? []),
			formatAllowFrom: ({ allowFrom }) => trimAllowFromEntries(allowFrom).map((entry) => entry.replace(/^(telegram|tg):/i, "")).map((entry) => entry.toLowerCase()),
			resolveDefaultTo: ({ cfg, accountId }) => {
				const val = resolveTelegramAccount({
					cfg,
					accountId
				}).config.defaultTo;
				return val != null ? String(val) : void 0;
			}
		},
		groups: {
			resolveRequireMention: resolveTelegramGroupRequireMention,
			resolveToolPolicy: resolveTelegramGroupToolPolicy
		},
		threading: {
			resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "off",
			buildToolContext: ({ context, hasRepliedRef }) => {
				const threadId = context.MessageThreadId;
				const rawCurrentMessageId = context.CurrentMessageId;
				const currentMessageId = typeof rawCurrentMessageId === "number" ? rawCurrentMessageId : rawCurrentMessageId?.trim() || void 0;
				return {
					currentChannelId: context.To?.trim() || void 0,
					currentThreadTs: threadId != null ? String(threadId) : void 0,
					currentMessageId,
					hasRepliedRef
				};
			}
		}
	},
	whatsapp: {
		id: "whatsapp",
		capabilities: {
			chatTypes: ["direct", "group"],
			polls: true,
			reactions: true,
			media: true
		},
		commands: {
			enforceOwnerForCommands: true,
			skipWhenConfigEmpty: true
		},
		outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => resolveWhatsAppAccount({
				cfg,
				accountId
			}).allowFrom ?? [],
			formatAllowFrom: ({ allowFrom }) => normalizeWhatsAppAllowFromEntries(allowFrom),
			resolveDefaultTo: ({ cfg, accountId }) => {
				const root = cfg.channels?.whatsapp;
				const normalized = normalizeAccountId(accountId);
				return ((root?.accounts?.[normalized])?.defaultTo ?? root?.defaultTo)?.trim() || void 0;
			}
		},
		groups: {
			resolveRequireMention: resolveWhatsAppGroupRequireMention,
			resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
			resolveGroupIntroHint: resolveWhatsAppGroupIntroHint
		},
		mentions: { stripPatterns: ({ ctx }) => resolveWhatsAppMentionStripPatterns(ctx) },
		threading: { buildToolContext: ({ context, hasRepliedRef }) => {
			return {
				currentChannelId: context.From?.trim() || context.To?.trim() || void 0,
				currentThreadTs: context.ReplyToId,
				hasRepliedRef
			};
		} }
	},
	discord: {
		id: "discord",
		capabilities: {
			chatTypes: [
				"direct",
				"channel",
				"thread"
			],
			polls: true,
			reactions: true,
			media: true,
			nativeCommands: true,
			threads: true
		},
		outbound: { textChunkLimit: 2e3 },
		streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
		elevated: { allowFromFallback: ({ cfg }) => cfg.channels?.discord?.allowFrom ?? cfg.channels?.discord?.dm?.allowFrom },
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => {
				const account = resolveDiscordAccount({
					cfg,
					accountId
				});
				return (account.config.allowFrom ?? account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
			},
			formatAllowFrom: ({ allowFrom }) => formatDiscordAllowFrom(allowFrom),
			resolveDefaultTo: ({ cfg, accountId }) => resolveDiscordAccount({
				cfg,
				accountId
			}).config.defaultTo?.trim() || void 0
		},
		groups: {
			resolveRequireMention: resolveDiscordGroupRequireMention,
			resolveToolPolicy: resolveDiscordGroupToolPolicy
		},
		mentions: { stripPatterns: () => ["<@!?\\d+>"] },
		threading: {
			resolveReplyToMode: ({ cfg }) => cfg.channels?.discord?.replyToMode ?? "off",
			buildToolContext: ({ context, hasRepliedRef }) => ({
				currentChannelId: context.To?.trim() || void 0,
				currentThreadTs: context.ReplyToId,
				hasRepliedRef
			})
		}
	},
	irc: {
		id: "irc",
		capabilities: {
			chatTypes: ["direct", "group"],
			media: true,
			blockStreaming: true
		},
		outbound: { textChunkLimit: 350 },
		streaming: { blockStreamingCoalesceDefaults: {
			minChars: 300,
			idleMs: 1e3
		} },
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => {
				const channel = cfg.channels?.irc;
				return (resolveCaseInsensitiveAccount(channel?.accounts, accountId)?.allowFrom ?? channel?.allowFrom ?? []).map((entry) => String(entry));
			},
			formatAllowFrom: ({ allowFrom }) => formatAllowFromWithReplacements(allowFrom, [/^irc:/i, /^user:/i]),
			resolveDefaultTo: ({ cfg, accountId }) => resolveNamedChannelDefaultTo({
				channels: cfg.channels,
				channelId: "irc",
				accountId
			})
		},
		groups: {
			resolveRequireMention: ({ cfg, accountId, groupId }) => {
				if (!groupId) return true;
				return resolveChannelGroupRequireMention({
					cfg,
					channel: "irc",
					groupId,
					accountId,
					groupIdCaseInsensitive: true
				});
			},
			resolveToolPolicy: ({ cfg, accountId, groupId, senderId, senderName, senderUsername }) => {
				if (!groupId) return;
				return resolveChannelGroupToolsPolicy({
					cfg,
					channel: "irc",
					groupId,
					accountId,
					groupIdCaseInsensitive: true,
					senderId,
					senderName,
					senderUsername
				});
			}
		}
	},
	googlechat: {
		id: "googlechat",
		capabilities: {
			chatTypes: [
				"direct",
				"group",
				"thread"
			],
			reactions: true,
			media: true,
			threads: true,
			blockStreaming: true
		},
		outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => {
				const channel = cfg.channels?.googlechat;
				return (resolveCaseInsensitiveAccount(channel?.accounts, accountId)?.dm?.allowFrom ?? channel?.dm?.allowFrom ?? []).map((entry) => String(entry));
			},
			formatAllowFrom: ({ allowFrom }) => formatAllowFromWithReplacements(allowFrom, [
				/^(googlechat|google-chat|gchat):/i,
				/^user:/i,
				/^users\//i
			]),
			resolveDefaultTo: ({ cfg, accountId }) => resolveNamedChannelDefaultTo({
				channels: cfg.channels,
				channelId: "googlechat",
				accountId
			})
		},
		groups: {
			resolveRequireMention: resolveGoogleChatGroupRequireMention,
			resolveToolPolicy: resolveGoogleChatGroupToolPolicy
		},
		threading: {
			resolveReplyToMode: ({ cfg }) => cfg.channels?.googlechat?.replyToMode ?? "off",
			buildToolContext: ({ context, hasRepliedRef }) => buildThreadToolContextFromMessageThreadOrReply({
				context,
				hasRepliedRef
			})
		}
	},
	slack: {
		id: "slack",
		capabilities: {
			chatTypes: [
				"direct",
				"channel",
				"thread"
			],
			reactions: true,
			media: true,
			nativeCommands: true,
			threads: true
		},
		outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
		streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => {
				const account = resolveSlackAccount({
					cfg,
					accountId
				});
				return (account.config.allowFrom ?? account.dm?.allowFrom ?? []).map((entry) => String(entry));
			},
			formatAllowFrom: ({ allowFrom }) => formatLower(allowFrom),
			resolveDefaultTo: ({ cfg, accountId }) => resolveSlackAccount({
				cfg,
				accountId
			}).config.defaultTo?.trim() || void 0
		},
		groups: {
			resolveRequireMention: resolveSlackGroupRequireMention,
			resolveToolPolicy: resolveSlackGroupToolPolicy
		},
		mentions: { stripPatterns: () => ["<@[^>]+>"] },
		threading: {
			resolveReplyToMode: ({ cfg, accountId, chatType }) => resolveSlackReplyToMode(resolveSlackAccount({
				cfg,
				accountId
			}), chatType),
			allowExplicitReplyTagsWhenOff: false,
			buildToolContext: (params) => buildSlackThreadingToolContext(params)
		}
	},
	signal: {
		id: "signal",
		capabilities: {
			chatTypes: ["direct", "group"],
			reactions: true,
			media: true
		},
		outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
		streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => stringifyAllowFrom(resolveSignalAccount({
				cfg,
				accountId
			}).config.allowFrom ?? []),
			formatAllowFrom: ({ allowFrom }) => trimAllowFromEntries(allowFrom).map((entry) => entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))).filter(Boolean),
			resolveDefaultTo: ({ cfg, accountId }) => resolveSignalAccount({
				cfg,
				accountId
			}).config.defaultTo?.trim() || void 0
		},
		threading: { buildToolContext: ({ context, hasRepliedRef }) => buildSignalThreadToolContext({
			context,
			hasRepliedRef
		}) }
	},
	imessage: {
		id: "imessage",
		capabilities: {
			chatTypes: ["direct", "group"],
			reactions: true,
			media: true
		},
		outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
		config: {
			resolveAllowFrom: ({ cfg, accountId }) => (resolveIMessageAccount({
				cfg,
				accountId
			}).config.allowFrom ?? []).map((entry) => String(entry)),
			formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
			resolveDefaultTo: ({ cfg, accountId }) => resolveIMessageAccount({
				cfg,
				accountId
			}).config.defaultTo?.trim() || void 0
		},
		groups: {
			resolveRequireMention: resolveIMessageGroupRequireMention,
			resolveToolPolicy: resolveIMessageGroupToolPolicy
		},
		threading: { buildToolContext: ({ context, hasRepliedRef }) => buildIMessageThreadToolContext({
			context,
			hasRepliedRef
		}) }
	}
};
function buildDockFromPlugin(plugin) {
	return {
		id: plugin.id,
		capabilities: plugin.capabilities,
		commands: plugin.commands,
		outbound: plugin.outbound?.textChunkLimit ? { textChunkLimit: plugin.outbound.textChunkLimit } : void 0,
		streaming: plugin.streaming ? { blockStreamingCoalesceDefaults: plugin.streaming.blockStreamingCoalesceDefaults } : void 0,
		elevated: plugin.elevated,
		config: plugin.config ? {
			resolveAllowFrom: plugin.config.resolveAllowFrom,
			formatAllowFrom: plugin.config.formatAllowFrom,
			resolveDefaultTo: plugin.config.resolveDefaultTo
		} : void 0,
		groups: plugin.groups,
		mentions: plugin.mentions,
		threading: plugin.threading,
		agentPrompt: plugin.agentPrompt
	};
}
function listPluginDockEntries() {
	const registry = requireActivePluginRegistry();
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of registry.channels) {
		const plugin = entry.plugin;
		const id = String(plugin.id).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		if (CHAT_CHANNEL_ORDER.includes(plugin.id)) continue;
		const dock = entry.dock ?? buildDockFromPlugin(plugin);
		entries.push({
			id: plugin.id,
			dock,
			order: plugin.meta.order
		});
	}
	return entries;
}
function listChannelDocks() {
	const baseEntries = CHAT_CHANNEL_ORDER.map((id) => ({
		id,
		dock: DOCKS[id],
		order: getChatChannelMeta(id).order
	}));
	const pluginEntries = listPluginDockEntries();
	const combined = [...baseEntries, ...pluginEntries];
	combined.sort((a, b) => {
		const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
		const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
		const orderA = a.order ?? (indexA === -1 ? 999 : indexA);
		const orderB = b.order ?? (indexB === -1 ? 999 : indexB);
		if (orderA !== orderB) return orderA - orderB;
		return String(a.id).localeCompare(String(b.id));
	});
	return combined.map((entry) => entry.dock);
}
function getChannelDock(id) {
	const core = DOCKS[id];
	if (core) return core;
	const pluginEntry = requireActivePluginRegistry().channels.find((entry) => entry.plugin.id === id);
	if (!pluginEntry) return;
	return pluginEntry.dock ?? buildDockFromPlugin(pluginEntry.plugin);
}

//#endregion
export { resolveChannelGroupRequireMention as a, normalizeHyphenSlug as c, TOOLS_BY_SENDER_KEY_TYPES as d, parseToolsBySenderTypedKey as f, resolveChannelGroupPolicy as i, normalizeStringEntries as l, listChannelDocks as n, resolveChannelGroupToolsPolicy as o, normalizeSignalMessagingTarget as r, normalizeAtHashSlug as s, getChannelDock as t, normalizeStringEntriesLower as u };