import {
  buildChannelKeyCandidates,
  evaluateMatchedGroupAccessForPolicy,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveMentionGatingWithBypass,
  resolveNestedAllowlistDecision
} from "openclaw/plugin-sdk/nextcloud-talk";
function normalizeAllowEntry(raw) {
  return raw.trim().toLowerCase().replace(/^(nextcloud-talk|nc-talk|nc):/i, "");
}
function normalizeNextcloudTalkAllowlist(values) {
  return (values ?? []).map((value) => normalizeAllowEntry(String(value))).filter(Boolean);
}
function resolveNextcloudTalkAllowlistMatch(params) {
  const allowFrom = normalizeNextcloudTalkAllowlist(params.allowFrom);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const senderId = normalizeAllowEntry(params.senderId);
  if (allowFrom.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  return { allowed: false };
}
function resolveNextcloudTalkRoomMatch(params) {
  const rooms = params.rooms ?? {};
  const allowlistConfigured = Object.keys(rooms).length > 0;
  const roomName = params.roomName?.trim() || void 0;
  const roomCandidates = buildChannelKeyCandidates(
    params.roomToken,
    roomName,
    roomName ? normalizeChannelSlug(roomName) : void 0
  );
  const match = resolveChannelEntryMatchWithFallback({
    entries: rooms,
    keys: roomCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug
  });
  const roomConfig = match.entry;
  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(roomConfig),
    innerConfigured: false,
    innerMatched: false
  });
  return {
    roomConfig,
    wildcardConfig: match.wildcardEntry,
    roomKey: match.matchKey ?? match.key,
    matchSource: match.matchSource,
    allowed,
    allowlistConfigured
  };
}
function resolveNextcloudTalkGroupToolPolicy(params) {
  const cfg = params.cfg;
  const roomToken = params.groupId?.trim();
  if (!roomToken) {
    return void 0;
  }
  const roomName = params.groupChannel?.trim() || void 0;
  const match = resolveNextcloudTalkRoomMatch({
    rooms: cfg.channels?.["nextcloud-talk"]?.rooms,
    roomToken,
    roomName
  });
  return match.roomConfig?.tools ?? match.wildcardConfig?.tools;
}
function resolveNextcloudTalkRequireMention(params) {
  if (typeof params.roomConfig?.requireMention === "boolean") {
    return params.roomConfig.requireMention;
  }
  if (typeof params.wildcardConfig?.requireMention === "boolean") {
    return params.wildcardConfig.requireMention;
  }
  return true;
}
function resolveNextcloudTalkGroupAllow(params) {
  const outerAllow = normalizeNextcloudTalkAllowlist(params.outerAllowFrom);
  const innerAllow = normalizeNextcloudTalkAllowlist(params.innerAllowFrom);
  const outerMatch = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.outerAllowFrom,
    senderId: params.senderId
  });
  const innerMatch = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.innerAllowFrom,
    senderId: params.senderId
  });
  const access = evaluateMatchedGroupAccessForPolicy({
    groupPolicy: params.groupPolicy,
    allowlistConfigured: outerAllow.length > 0 || innerAllow.length > 0,
    allowlistMatched: resolveNestedAllowlistDecision({
      outerConfigured: outerAllow.length > 0 || innerAllow.length > 0,
      outerMatched: outerAllow.length > 0 ? outerMatch.allowed : true,
      innerConfigured: innerAllow.length > 0,
      innerMatched: innerMatch.allowed
    })
  });
  return {
    allowed: access.allowed,
    outerMatch: params.groupPolicy === "open" ? { allowed: true } : params.groupPolicy === "disabled" ? { allowed: false } : outerMatch,
    innerMatch: params.groupPolicy === "open" ? { allowed: true } : params.groupPolicy === "disabled" ? { allowed: false } : innerMatch
  };
}
function resolveNextcloudTalkMentionGate(params) {
  const result = resolveMentionGatingWithBypass({
    isGroup: params.isGroup,
    requireMention: params.requireMention,
    canDetectMention: true,
    wasMentioned: params.wasMentioned,
    allowTextCommands: params.allowTextCommands,
    hasControlCommand: params.hasControlCommand,
    commandAuthorized: params.commandAuthorized
  });
  return { shouldSkip: result.shouldSkip, shouldBypassMention: result.shouldBypassMention };
}
export {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkGroupToolPolicy,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch
};
