import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { n as parseToolsBySenderTypedKey } from "./types.tools-CJYS3wEg.js";
import { n as normalizeMessageChannel } from "./message-channel-core-BoUoCGOD.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
//#region src/config/group-policy.ts
function resolveChannelGroupConfig(groups, groupId, caseInsensitive = false) {
	if (!groups) return;
	const direct = groups[groupId];
	if (direct) return direct;
	if (!caseInsensitive) return;
	const target = normalizeLowercaseStringOrEmpty(groupId);
	const matchedKey = Object.keys(groups).find((key) => key !== "*" && normalizeLowercaseStringOrEmpty(key) === target);
	if (!matchedKey) return;
	return groups[matchedKey];
}
const warnedLegacyToolsBySenderKeys = /* @__PURE__ */ new Set();
const compiledToolsBySenderCache = /* @__PURE__ */ new WeakMap();
function normalizeSenderKey(value, options = {}) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return normalizeLowercaseStringOrEmpty(options.stripLeadingAt && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed);
}
function normalizeTypedSenderKey(value, type) {
	if (type === "channel") return normalizeChannelSenderKey(value);
	return normalizeSenderKey(value, { stripLeadingAt: type === "username" });
}
function normalizeSenderPolicyChannel(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return "";
	return normalizeMessageChannel(trimmed) ?? normalizeSenderKey(trimmed);
}
function normalizeChannelSenderKey(value) {
	const trimmed = value.trim();
	const separatorIndex = trimmed.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return "";
	const channel = normalizeSenderPolicyChannel(trimmed.slice(0, separatorIndex));
	const senderId = normalizeTypedSenderKey(trimmed.slice(separatorIndex + 1), "id");
	if (!channel || !senderId) return "";
	return `${channel}:${senderId}`;
}
function normalizeLegacySenderKey(value) {
	return normalizeSenderKey(value, { stripLeadingAt: true });
}
function warnLegacyToolsBySenderKey(rawKey) {
	const trimmed = rawKey.trim();
	if (!trimmed || warnedLegacyToolsBySenderKeys.has(trimmed)) return;
	warnedLegacyToolsBySenderKeys.add(trimmed);
	process.emitWarning(`toolsBySender key "${trimmed}" is deprecated. Use explicit prefixes (channel:, id:, e164:, username:, name:). Legacy unprefixed keys are matched as id only.`, {
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
		channel: /* @__PURE__ */ new Map(),
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
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return "";
	return normalizeTypedSenderKey(trimmed, type);
}
function normalizeSenderIdCandidates(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return [];
	const typed = normalizeTypedSenderKey(trimmed, "id");
	const legacy = normalizeLegacySenderKey(trimmed);
	if (!typed) return legacy ? [legacy] : [];
	if (!legacy || legacy === typed) return [typed];
	return [typed, legacy];
}
function matchToolsBySenderPolicy(compiled, params) {
	const senderIdCandidates = normalizeSenderIdCandidates(params.senderId);
	const channel = normalizeSenderPolicyChannel(params.messageProvider);
	if (channel) for (const senderIdCandidate of senderIdCandidates) {
		const match = compiled.buckets.channel.get(`${channel}:${senderIdCandidate}`);
		if (match) return match;
	}
	for (const senderIdCandidate of senderIdCandidates) {
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
	const accountGroups = resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groups;
	if (!(Object.keys(channelConfig.accounts ?? {}).length > 1)) return accountGroups && Object.keys(accountGroups).length > 0 ? accountGroups : channelConfig.groups;
	return accountGroups ?? channelConfig.groups;
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
	if (params.configuredGroupDefaultsToNoMention && groupConfig) return false;
	return true;
}
function resolveChannelGroupToolsPolicy(params) {
	const groups = resolveChannelGroups(params.cfg, params.channel, params.accountId);
	const groupIds = [params.groupId, ...Array.isArray(params.groupIdCandidates) ? params.groupIdCandidates : []];
	let groupConfig;
	for (const rawGroupId of groupIds) {
		const groupId = rawGroupId?.trim();
		if (!groupId) continue;
		groupConfig = resolveChannelGroupConfig(groups, groupId, params.groupIdCaseInsensitive);
		if (groupConfig) break;
	}
	const defaultConfig = groups?.["*"];
	const groupSenderPolicy = resolveToolsBySender({
		toolsBySender: groupConfig?.toolsBySender,
		messageProvider: params.messageProvider ?? params.channel,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	if (groupSenderPolicy) return groupSenderPolicy;
	if (groupConfig?.tools) return groupConfig.tools;
	const defaultSenderPolicy = resolveToolsBySender({
		toolsBySender: defaultConfig?.toolsBySender,
		messageProvider: params.messageProvider ?? params.channel,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
	if (defaultSenderPolicy) return defaultSenderPolicy;
	if (defaultConfig?.tools) return defaultConfig.tools;
}
//#endregion
export { resolveToolsBySender as i, resolveChannelGroupRequireMention as n, resolveChannelGroupToolsPolicy as r, resolveChannelGroupPolicy as t };
