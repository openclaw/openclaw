import {
  buildChannelKeyCandidates,
  resolveChannelEntryMatchWithFallback,
  resolveChannelMatchConfig
} from "../../../../src/channels/channel-config.js";
import { evaluateGroupRouteAccessForPolicy } from "../../../../src/plugin-sdk/group-access.js";
import { formatDiscordUserTag } from "./format.js";
const DISCORD_OWNER_ALLOWLIST_PREFIXES = ["discord:", "user:", "pk:"];
function normalizeDiscordAllowList(raw, prefixes) {
  if (!raw || raw.length === 0) {
    return null;
  }
  const ids = /* @__PURE__ */ new Set();
  const names = /* @__PURE__ */ new Set();
  const allowAll = raw.some((entry) => String(entry).trim() === "*");
  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text || text === "*") {
      continue;
    }
    const normalized = normalizeDiscordSlug(text);
    const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
    if (/^\d+$/.test(maybeId)) {
      ids.add(maybeId);
      continue;
    }
    const prefix = prefixes.find((entry2) => text.startsWith(entry2));
    if (prefix) {
      const candidate = text.slice(prefix.length);
      if (candidate) {
        ids.add(candidate);
      }
      continue;
    }
    if (normalized) {
      names.add(normalized);
    }
  }
  return { allowAll, ids, names };
}
function normalizeDiscordSlug(value) {
  return value.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function resolveDiscordAllowListNameMatch(list, candidate) {
  const nameSlug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
  if (nameSlug && list.names.has(nameSlug)) {
    return { matchKey: nameSlug, matchSource: "name" };
  }
  const tagSlug = candidate.tag ? normalizeDiscordSlug(candidate.tag) : "";
  if (tagSlug && list.names.has(tagSlug)) {
    return { matchKey: tagSlug, matchSource: "tag" };
  }
  return null;
}
function allowListMatches(list, candidate, params) {
  if (list.allowAll) {
    return true;
  }
  if (candidate.id && list.ids.has(candidate.id)) {
    return true;
  }
  if (params?.allowNameMatching === true) {
    if (resolveDiscordAllowListNameMatch(list, candidate)) {
      return true;
    }
  }
  return false;
}
function resolveDiscordAllowListMatch(params) {
  const { allowList, candidate } = params;
  if (allowList.allowAll) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  if (candidate.id && allowList.ids.has(candidate.id)) {
    return { allowed: true, matchKey: candidate.id, matchSource: "id" };
  }
  if (params.allowNameMatching === true) {
    const namedMatch = resolveDiscordAllowListNameMatch(allowList, candidate);
    if (namedMatch) {
      return { allowed: true, ...namedMatch };
    }
  }
  return { allowed: false };
}
function resolveDiscordUserAllowed(params) {
  const allowList = normalizeDiscordAllowList(params.allowList, ["discord:", "user:", "pk:"]);
  if (!allowList) {
    return true;
  }
  return allowListMatches(
    allowList,
    {
      id: params.userId,
      name: params.userName,
      tag: params.userTag
    },
    { allowNameMatching: params.allowNameMatching }
  );
}
function resolveDiscordRoleAllowed(params) {
  const allowList = normalizeDiscordAllowList(params.allowList, ["role:"]);
  if (!allowList) {
    return true;
  }
  if (allowList.allowAll) {
    return true;
  }
  return params.memberRoleIds.some((roleId) => allowList.ids.has(roleId));
}
function resolveDiscordMemberAllowed(params) {
  const hasUserRestriction = Array.isArray(params.userAllowList) && params.userAllowList.length > 0;
  const hasRoleRestriction = Array.isArray(params.roleAllowList) && params.roleAllowList.length > 0;
  if (!hasUserRestriction && !hasRoleRestriction) {
    return true;
  }
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
  const hasAccessRestrictions = Array.isArray(channelUsers) && channelUsers.length > 0 || Array.isArray(channelRoles) && channelRoles.length > 0;
  const memberAllowed = resolveDiscordMemberAllowed({
    userAllowList: channelUsers,
    roleAllowList: channelRoles,
    memberRoleIds: params.memberRoleIds,
    userId: params.sender.id,
    userName: params.sender.name,
    userTag: params.sender.tag,
    allowNameMatching: params.allowNameMatching
  });
  return { channelUsers, channelRoles, hasAccessRestrictions, memberAllowed };
}
function resolveDiscordOwnerAllowFrom(params) {
  const rawAllowList = params.channelConfig?.users ?? params.guildInfo?.users;
  if (!Array.isArray(rawAllowList) || rawAllowList.length === 0) {
    return void 0;
  }
  const allowList = normalizeDiscordAllowList(rawAllowList, ["discord:", "user:", "pk:"]);
  if (!allowList) {
    return void 0;
  }
  const match = resolveDiscordAllowListMatch({
    allowList,
    candidate: {
      id: params.sender.id,
      name: params.sender.name,
      tag: params.sender.tag
    },
    allowNameMatching: params.allowNameMatching
  });
  if (!match.allowed || !match.matchKey || match.matchKey === "*") {
    return void 0;
  }
  return [match.matchKey];
}
function resolveDiscordOwnerAccess(params) {
  const ownerAllowList = normalizeDiscordAllowList(
    params.allowFrom,
    DISCORD_OWNER_ALLOWLIST_PREFIXES
  );
  const ownerAllowed = ownerAllowList ? allowListMatches(
    ownerAllowList,
    {
      id: params.sender.id,
      name: params.sender.name,
      tag: params.sender.tag
    },
    { allowNameMatching: params.allowNameMatching }
  ) : false;
  return { ownerAllowList, ownerAllowed };
}
function resolveDiscordCommandAuthorized(params) {
  if (!params.isDirectMessage) {
    return true;
  }
  const allowList = normalizeDiscordAllowList(params.allowFrom, ["discord:", "user:", "pk:"]);
  if (!allowList) {
    return true;
  }
  return allowListMatches(
    allowList,
    {
      id: params.author.id,
      name: params.author.username,
      tag: formatDiscordUserTag(params.author)
    },
    { allowNameMatching: params.allowNameMatching }
  );
}
function resolveDiscordGuildEntry(params) {
  const guild = params.guild;
  const entries = params.guildEntries;
  const guildId = params.guildId?.trim() || guild?.id;
  if (!entries) {
    return null;
  }
  const byId = guildId ? entries[guildId] : void 0;
  if (byId) {
    return { ...byId, id: guildId };
  }
  if (!guild) {
    return null;
  }
  const slug = normalizeDiscordSlug(guild.name ?? "");
  const bySlug = entries[slug];
  if (bySlug) {
    return { ...bySlug, id: guildId ?? guild.id, slug: slug || bySlug.slug };
  }
  const wildcard = entries["*"];
  if (wildcard) {
    return { ...wildcard, id: guildId ?? guild.id, slug: slug || wildcard.slug };
  }
  return null;
}
function buildDiscordChannelKeys(params) {
  const allowNameMatch = params.allowNameMatch !== false;
  return buildChannelKeyCandidates(
    params.id,
    allowNameMatch ? params.slug : void 0,
    allowNameMatch ? params.name : void 0
  );
}
function resolveDiscordChannelEntryMatch(channels, params, parentParams) {
  const keys = buildDiscordChannelKeys(params);
  const parentKeys = parentParams ? buildDiscordChannelKeys(parentParams) : void 0;
  return resolveChannelEntryMatchWithFallback({
    entries: channels,
    keys,
    parentKeys,
    wildcardKey: "*"
  });
}
function hasConfiguredDiscordChannels(channels) {
  return Boolean(channels && Object.keys(channels).length > 0);
}
function resolveDiscordChannelConfigEntry(entry) {
  const resolved = {
    allowed: entry.allow !== false,
    requireMention: entry.requireMention,
    ignoreOtherMentions: entry.ignoreOtherMentions,
    skills: entry.skills,
    enabled: entry.enabled,
    users: entry.users,
    roles: entry.roles,
    systemPrompt: entry.systemPrompt,
    includeThreadStarter: entry.includeThreadStarter,
    autoThread: entry.autoThread,
    autoArchiveDuration: entry.autoArchiveDuration
  };
  return resolved;
}
function resolveDiscordChannelConfig(params) {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channels = guildInfo?.channels;
  if (!hasConfiguredDiscordChannels(channels)) {
    return null;
  }
  const match = resolveDiscordChannelEntryMatch(channels, {
    id: channelId,
    name: channelName,
    slug: channelSlug
  });
  const resolved = resolveChannelMatchConfig(match, resolveDiscordChannelConfigEntry);
  return resolved ?? { allowed: false };
}
function resolveDiscordChannelConfigWithFallback(params) {
  const {
    guildInfo,
    channelId,
    channelName,
    channelSlug,
    parentId,
    parentName,
    parentSlug,
    scope
  } = params;
  const channels = guildInfo?.channels;
  if (!hasConfiguredDiscordChannels(channels)) {
    return null;
  }
  const resolvedParentSlug = parentSlug ?? (parentName ? normalizeDiscordSlug(parentName) : "");
  const match = resolveDiscordChannelEntryMatch(
    channels,
    {
      id: channelId,
      name: channelName,
      slug: channelSlug,
      allowNameMatch: scope !== "thread"
    },
    parentId || parentName || parentSlug ? {
      id: parentId ?? "",
      name: parentName,
      slug: resolvedParentSlug
    } : void 0
  );
  return resolveChannelMatchConfig(match, resolveDiscordChannelConfigEntry) ?? { allowed: false };
}
function resolveDiscordShouldRequireMention(params) {
  if (!params.isGuildMessage) {
    return false;
  }
  const isBotThread = params.isAutoThreadOwnedByBot ?? isDiscordAutoThreadOwnedByBot(params);
  if (isBotThread) {
    return false;
  }
  return params.channelConfig?.requireMention ?? params.guildInfo?.requireMention ?? true;
}
function isDiscordAutoThreadOwnedByBot(params) {
  if (!params.isThread) {
    return false;
  }
  if (!params.channelConfig?.autoThread) {
    return false;
  }
  const botId = params.botId?.trim();
  const threadOwnerId = params.threadOwnerId?.trim();
  return Boolean(botId && threadOwnerId && botId === threadOwnerId);
}
function isDiscordGroupAllowedByPolicy(params) {
  if (params.groupPolicy === "allowlist" && !params.guildAllowlisted) {
    return false;
  }
  return evaluateGroupRouteAccessForPolicy({
    groupPolicy: params.groupPolicy === "allowlist" && !params.channelAllowlistConfigured ? "open" : params.groupPolicy,
    routeAllowlistConfigured: params.channelAllowlistConfigured,
    routeMatched: params.channelAllowed
  }).allowed;
}
function resolveGroupDmAllow(params) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) {
    return true;
  }
  const allowList = new Set(channels.map((entry) => normalizeDiscordSlug(String(entry))));
  const candidates = [
    normalizeDiscordSlug(channelId),
    channelSlug,
    channelName ? normalizeDiscordSlug(channelName) : ""
  ].filter(Boolean);
  return allowList.has("*") || candidates.some((candidate) => allowList.has(candidate));
}
function shouldEmitDiscordReactionNotification(params) {
  const mode = params.mode ?? "own";
  if (mode === "off") {
    return false;
  }
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
  if (mode === "allowlist") {
    return hasAccessRestrictions && memberAllowed;
  }
  if (hasAccessRestrictions && !memberAllowed) {
    return false;
  }
  if (mode === "all") {
    return true;
  }
  if (mode === "own") {
    return Boolean(params.botId && params.messageAuthorId === params.botId);
  }
  return false;
}
export {
  allowListMatches,
  isDiscordAutoThreadOwnedByBot,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordCommandAuthorized,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAccess,
  resolveDiscordOwnerAllowFrom,
  resolveDiscordRoleAllowed,
  resolveDiscordShouldRequireMention,
  resolveDiscordUserAllowed,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification
};
