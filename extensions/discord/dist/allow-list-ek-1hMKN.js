import { n as formatDiscordUserTag } from "./format-D8TsaXxW.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { buildChannelKeyCandidates, resolveChannelEntryMatchWithFallback, resolveChannelMatchConfig } from "openclaw/plugin-sdk/channel-targets";
import { evaluateGroupRouteAccessForPolicy } from "openclaw/plugin-sdk/group-access";
//#region extensions/discord/src/monitor/allow-list.ts
const DISCORD_OWNER_ALLOWLIST_PREFIXES = [
	"discord:",
	"user:",
	"pk:"
];
function normalizeDiscordAllowList(raw, prefixes) {
	if (!raw || raw.length === 0) return null;
	const ids = /* @__PURE__ */ new Set();
	const names = /* @__PURE__ */ new Set();
	const allowAll = raw.some((entry) => (normalizeOptionalString(entry) ?? "") === "*");
	for (const entry of raw) {
		const text = normalizeOptionalString(entry) ?? "";
		if (!text || text === "*") continue;
		const normalized = normalizeDiscordSlug(text);
		const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
		if (/^\d+$/.test(maybeId)) {
			ids.add(maybeId);
			continue;
		}
		const prefix = prefixes.find((entry) => text.startsWith(entry));
		if (prefix) {
			const candidate = text.slice(prefix.length);
			if (candidate) ids.add(candidate);
			continue;
		}
		if (normalized) names.add(normalized);
	}
	return {
		allowAll,
		ids,
		names
	};
}
function normalizeDiscordSlug(value) {
	return normalizeLowercaseStringOrEmpty(value).replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function normalizeDiscordDisplaySlug(value) {
	return normalizeLowercaseStringOrEmpty(value).normalize("NFC").replace(/^#/, "").replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{M}\p{N}-]+/gu, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
function resolveDiscordAllowListNameMatch(list, candidate) {
	const nameSlug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
	if (nameSlug && list.names.has(nameSlug)) return {
		matchKey: nameSlug,
		matchSource: "name"
	};
	const tagSlug = candidate.tag ? normalizeDiscordSlug(candidate.tag) : "";
	if (tagSlug && list.names.has(tagSlug)) return {
		matchKey: tagSlug,
		matchSource: "tag"
	};
	return null;
}
function allowListMatches(list, candidate, params) {
	if (list.allowAll) return true;
	if (candidate.id && list.ids.has(candidate.id)) return true;
	if (params?.allowNameMatching === true) {
		if (resolveDiscordAllowListNameMatch(list, candidate)) return true;
	}
	return false;
}
function resolveDiscordAllowListMatch(params) {
	const { allowList, candidate } = params;
	if (allowList.allowAll) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	if (candidate.id && allowList.ids.has(candidate.id)) return {
		allowed: true,
		matchKey: candidate.id,
		matchSource: "id"
	};
	if (params.allowNameMatching === true) {
		const namedMatch = resolveDiscordAllowListNameMatch(allowList, candidate);
		if (namedMatch) return {
			allowed: true,
			...namedMatch
		};
	}
	return { allowed: false };
}
function resolveDiscordUserAllowed(params) {
	const allowList = normalizeDiscordAllowList(params.allowList, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return true;
	return allowListMatches(allowList, {
		id: params.userId,
		name: params.userName,
		tag: params.userTag
	}, { allowNameMatching: params.allowNameMatching });
}
function resolveDiscordRoleAllowed(params) {
	const allowList = normalizeDiscordAllowList(params.allowList, ["role:"]);
	if (!allowList) return true;
	if (allowList.allowAll) return true;
	return params.memberRoleIds.some((roleId) => allowList.ids.has(roleId));
}
function resolveDiscordMemberAllowed(params) {
	const hasUserRestriction = Array.isArray(params.userAllowList) && params.userAllowList.length > 0;
	const hasRoleRestriction = Array.isArray(params.roleAllowList) && params.roleAllowList.length > 0;
	if (!hasUserRestriction && !hasRoleRestriction) return true;
	const userOk = hasUserRestriction ? resolveDiscordUserAllowed({
		allowList: params.userAllowList,
		userId: params.userId,
		userName: params.userName,
		userTag: params.userTag,
		allowNameMatching: params.allowNameMatching
	}) : false;
	const roleOk = hasRoleRestriction ? resolveDiscordRoleAllowed({
		allowList: params.roleAllowList,
		memberRoleIds: params.memberRoleIds
	}) : false;
	return userOk || roleOk;
}
function resolveDiscordMemberAccessState(params) {
	const channelUsers = params.channelConfig?.users ?? params.guildInfo?.users;
	const channelRoles = params.channelConfig?.roles ?? params.guildInfo?.roles;
	return {
		channelUsers,
		channelRoles,
		hasAccessRestrictions: Array.isArray(channelUsers) && channelUsers.length > 0 || Array.isArray(channelRoles) && channelRoles.length > 0,
		memberAllowed: resolveDiscordMemberAllowed({
			userAllowList: channelUsers,
			roleAllowList: channelRoles,
			memberRoleIds: params.memberRoleIds,
			userId: params.sender.id,
			userName: params.sender.name,
			userTag: params.sender.tag,
			allowNameMatching: params.allowNameMatching
		})
	};
}
function resolveDiscordOwnerAllowFrom(params) {
	const rawAllowList = params.channelConfig?.users ?? params.guildInfo?.users;
	if (!Array.isArray(rawAllowList) || rawAllowList.length === 0) return;
	const allowList = normalizeDiscordAllowList(rawAllowList, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return;
	const match = resolveDiscordAllowListMatch({
		allowList,
		candidate: {
			id: params.sender.id,
			name: params.sender.name,
			tag: params.sender.tag
		},
		allowNameMatching: params.allowNameMatching
	});
	if (!match.allowed || !match.matchKey || match.matchKey === "*") return;
	return [match.matchKey];
}
function resolveDiscordOwnerAccess(params) {
	const ownerAllowFrom = params.allowFrom?.filter((entry) => (normalizeOptionalString(entry) ?? "") !== "*");
	const ownerAllowList = normalizeDiscordAllowList(ownerAllowFrom && ownerAllowFrom.length > 0 ? ownerAllowFrom : void 0, DISCORD_OWNER_ALLOWLIST_PREFIXES);
	return {
		ownerAllowList,
		ownerAllowed: ownerAllowList ? allowListMatches(ownerAllowList, {
			id: params.sender.id,
			name: params.sender.name,
			tag: params.sender.tag
		}, { allowNameMatching: params.allowNameMatching }) : false
	};
}
function resolveDiscordCommandAuthorized(params) {
	if (!params.isDirectMessage) return true;
	const allowList = normalizeDiscordAllowList(params.allowFrom, [
		"discord:",
		"user:",
		"pk:"
	]);
	if (!allowList) return true;
	return allowListMatches(allowList, {
		id: params.author.id,
		name: params.author.username,
		tag: formatDiscordUserTag(params.author)
	}, { allowNameMatching: params.allowNameMatching });
}
function resolveDiscordGuildEntry(params) {
	const guild = params.guild;
	const entries = params.guildEntries;
	const guildId = params.guildId?.trim() || guild?.id;
	if (!entries) return null;
	const byId = guildId ? entries[guildId] : void 0;
	if (byId) return {
		...byId,
		id: guildId
	};
	if (!guild) return null;
	const slug = normalizeDiscordSlug(guild.name ?? "");
	const bySlug = entries[slug];
	if (bySlug) return {
		...bySlug,
		id: guildId ?? guild.id,
		slug: slug || bySlug.slug
	};
	const wildcard = entries["*"];
	if (wildcard) return {
		...wildcard,
		id: guildId ?? guild.id,
		slug: slug || wildcard.slug
	};
	return null;
}
function buildDiscordChannelKeys(params) {
	const allowNameMatch = params.allowNameMatch !== false;
	return buildChannelKeyCandidates(params.id, allowNameMatch ? params.slug : void 0, allowNameMatch ? params.name : void 0);
}
function resolveDiscordChannelEntryMatch(channels, params, parentParams) {
	return resolveChannelEntryMatchWithFallback({
		entries: channels,
		keys: buildDiscordChannelKeys(params),
		parentKeys: parentParams ? buildDiscordChannelKeys(parentParams) : void 0,
		wildcardKey: "*"
	});
}
function hasConfiguredDiscordChannels(channels) {
	return Boolean(channels && Object.keys(channels).length > 0);
}
function resolveDiscordChannelConfigEntry(entry) {
	return {
		allowed: entry.enabled !== false,
		requireMention: entry.requireMention,
		ignoreOtherMentions: entry.ignoreOtherMentions,
		skills: entry.skills,
		enabled: entry.enabled,
		users: entry.users,
		roles: entry.roles,
		systemPrompt: entry.systemPrompt,
		includeThreadStarter: entry.includeThreadStarter,
		autoThread: entry.autoThread,
		autoThreadName: entry.autoThreadName,
		autoArchiveDuration: entry.autoArchiveDuration
	};
}
function resolveDiscordChannelConfig(params) {
	const { guildInfo, channelId, channelName, channelSlug } = params;
	const channels = guildInfo?.channels;
	if (!hasConfiguredDiscordChannels(channels)) return null;
	return resolveChannelMatchConfig(resolveDiscordChannelEntryMatch(channels, {
		id: channelId,
		name: channelName,
		slug: channelSlug
	}), resolveDiscordChannelConfigEntry) ?? { allowed: false };
}
function resolveDiscordChannelConfigWithFallback(params) {
	const { guildInfo, channelId, channelName, channelSlug, parentId, parentName, parentSlug, scope } = params;
	const channels = guildInfo?.channels;
	if (!hasConfiguredDiscordChannels(channels)) return null;
	const resolvedParentSlug = parentSlug ?? (parentName ? normalizeDiscordSlug(parentName) : "");
	return resolveChannelMatchConfig(resolveDiscordChannelEntryMatch(channels, {
		id: channelId,
		name: channelName,
		slug: channelSlug,
		allowNameMatch: scope !== "thread"
	}, parentId || parentName || parentSlug ? {
		id: parentId ?? "",
		name: parentName,
		slug: resolvedParentSlug
	} : void 0), resolveDiscordChannelConfigEntry) ?? { allowed: false };
}
function resolveDiscordShouldRequireMention(params) {
	if (!params.isGuildMessage) return false;
	if (params.isAutoThreadOwnedByBot ?? isDiscordAutoThreadOwnedByBot(params)) return false;
	return params.channelConfig?.requireMention ?? params.guildInfo?.requireMention ?? true;
}
function isDiscordAutoThreadOwnedByBot(params) {
	if (!params.isThread) return false;
	if (!params.channelConfig?.autoThread) return false;
	const botId = params.botId?.trim();
	const threadOwnerId = params.threadOwnerId?.trim();
	return Boolean(botId && threadOwnerId && botId === threadOwnerId);
}
function isDiscordGroupAllowedByPolicy(params) {
	if (params.groupPolicy === "allowlist" && !params.guildAllowlisted) return false;
	return evaluateGroupRouteAccessForPolicy({
		groupPolicy: params.groupPolicy === "allowlist" && !params.channelAllowlistConfigured ? "open" : params.groupPolicy,
		routeAllowlistConfigured: params.channelAllowlistConfigured,
		routeMatched: params.channelAllowed
	}).allowed;
}
function resolveDiscordChannelPolicyCommandAuthorizer(params) {
	const channelAllowlistConfigured = Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
	return {
		configured: params.groupPolicy === "allowlist" && (Boolean(params.guildInfo) || channelAllowlistConfigured),
		allowed: isDiscordGroupAllowedByPolicy({
			groupPolicy: params.groupPolicy,
			guildAllowlisted: Boolean(params.guildInfo),
			channelAllowlistConfigured,
			channelAllowed: params.channelConfig?.allowed !== false
		})
	};
}
function resolveGroupDmAllow(params) {
	const { channels, channelId, channelName, channelSlug } = params;
	if (!channels || channels.length === 0) return true;
	const allowList = new Set(channels.map((entry) => normalizeDiscordSlug(entry)));
	const candidates = [
		normalizeDiscordSlug(channelId),
		channelSlug,
		channelName ? normalizeDiscordSlug(channelName) : ""
	].filter(Boolean);
	return allowList.has("*") || candidates.some((candidate) => allowList.has(candidate));
}
function shouldEmitDiscordReactionNotification(params) {
	const mode = params.mode ?? "own";
	if (mode === "off") return false;
	const accessGuildInfo = params.guildInfo ?? (params.allowlist ? { users: params.allowlist } : null);
	const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
		channelConfig: params.channelConfig,
		guildInfo: accessGuildInfo,
		memberRoleIds: params.memberRoleIds ?? [],
		sender: {
			id: params.userId,
			name: params.userName,
			tag: params.userTag
		},
		allowNameMatching: params.allowNameMatching
	});
	if (mode === "allowlist") return hasAccessRestrictions && memberAllowed;
	if (hasAccessRestrictions && !memberAllowed) return false;
	if (mode === "all") return true;
	if (mode === "own") return Boolean(params.botId && params.messageAuthorId === params.botId);
	return false;
}
//#endregion
export { resolveGroupDmAllow as _, normalizeDiscordSlug as a, resolveDiscordChannelConfigWithFallback as c, resolveDiscordGuildEntry as d, resolveDiscordMemberAccessState as f, resolveDiscordShouldRequireMention as g, resolveDiscordOwnerAllowFrom as h, normalizeDiscordDisplaySlug as i, resolveDiscordChannelPolicyCommandAuthorizer as l, resolveDiscordOwnerAccess as m, isDiscordGroupAllowedByPolicy as n, resolveDiscordAllowListMatch as o, resolveDiscordMemberAllowed as p, normalizeDiscordAllowList as r, resolveDiscordChannelConfig as s, allowListMatches as t, resolveDiscordCommandAuthorized as u, shouldEmitDiscordReactionNotification as v };
