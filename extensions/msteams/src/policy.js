import {
  buildChannelKeyCandidates,
  evaluateSenderGroupAccessForPolicy,
  normalizeChannelSlug,
  resolveAllowlistMatchSimple,
  resolveToolsBySender,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
  isDangerousNameMatchingEnabled
} from "openclaw/plugin-sdk/msteams";
function resolveMSTeamsRouteConfig(params) {
  const teamId = params.teamId?.trim();
  const teamName = params.teamName?.trim();
  const conversationId = params.conversationId?.trim();
  const channelName = params.channelName?.trim();
  const teams = params.cfg?.teams ?? {};
  const allowlistConfigured = Object.keys(teams).length > 0;
  const teamCandidates = buildChannelKeyCandidates(
    teamId,
    params.allowNameMatching ? teamName : void 0,
    params.allowNameMatching && teamName ? normalizeChannelSlug(teamName) : void 0
  );
  const teamMatch = resolveChannelEntryMatchWithFallback({
    entries: teams,
    keys: teamCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug
  });
  const teamConfig = teamMatch.entry;
  const channels = teamConfig?.channels ?? {};
  const channelAllowlistConfigured = Object.keys(channels).length > 0;
  const channelCandidates = buildChannelKeyCandidates(
    conversationId,
    params.allowNameMatching ? channelName : void 0,
    params.allowNameMatching && channelName ? normalizeChannelSlug(channelName) : void 0
  );
  const channelMatch = resolveChannelEntryMatchWithFallback({
    entries: channels,
    keys: channelCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug
  });
  const channelConfig = channelMatch.entry;
  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(teamConfig),
    innerConfigured: channelAllowlistConfigured,
    innerMatched: Boolean(channelConfig)
  });
  return {
    teamConfig,
    channelConfig,
    allowlistConfigured,
    allowed,
    teamKey: teamMatch.matchKey ?? teamMatch.key,
    channelKey: channelMatch.matchKey ?? channelMatch.key,
    channelMatchKey: channelMatch.matchKey,
    channelMatchSource: channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard" ? channelMatch.matchSource : void 0
  };
}
function resolveMSTeamsGroupToolPolicy(params) {
  const cfg = params.cfg.channels?.msteams;
  if (!cfg) {
    return void 0;
  }
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();
  const groupSpace = params.groupSpace?.trim();
  const allowNameMatching = isDangerousNameMatchingEnabled(cfg);
  const resolved = resolveMSTeamsRouteConfig({
    cfg,
    teamId: groupSpace,
    teamName: groupSpace,
    conversationId: groupId,
    channelName: groupChannel,
    allowNameMatching
  });
  if (resolved.channelConfig) {
    const senderPolicy = resolveToolsBySender({
      toolsBySender: resolved.channelConfig.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164
    });
    if (senderPolicy) {
      return senderPolicy;
    }
    if (resolved.channelConfig.tools) {
      return resolved.channelConfig.tools;
    }
    const teamSenderPolicy = resolveToolsBySender({
      toolsBySender: resolved.teamConfig?.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164
    });
    if (teamSenderPolicy) {
      return teamSenderPolicy;
    }
    return resolved.teamConfig?.tools;
  }
  if (resolved.teamConfig) {
    const teamSenderPolicy = resolveToolsBySender({
      toolsBySender: resolved.teamConfig.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164
    });
    if (teamSenderPolicy) {
      return teamSenderPolicy;
    }
    if (resolved.teamConfig.tools) {
      return resolved.teamConfig.tools;
    }
  }
  if (!groupId) {
    return void 0;
  }
  const channelCandidates = buildChannelKeyCandidates(
    groupId,
    allowNameMatching ? groupChannel : void 0,
    allowNameMatching && groupChannel ? normalizeChannelSlug(groupChannel) : void 0
  );
  for (const teamConfig of Object.values(cfg.teams ?? {})) {
    const match = resolveChannelEntryMatchWithFallback({
      entries: teamConfig?.channels ?? {},
      keys: channelCandidates,
      wildcardKey: "*",
      normalizeKey: normalizeChannelSlug
    });
    if (match.entry) {
      const senderPolicy = resolveToolsBySender({
        toolsBySender: match.entry.toolsBySender,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164
      });
      if (senderPolicy) {
        return senderPolicy;
      }
      if (match.entry.tools) {
        return match.entry.tools;
      }
      const teamSenderPolicy = resolveToolsBySender({
        toolsBySender: teamConfig?.toolsBySender,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164
      });
      if (teamSenderPolicy) {
        return teamSenderPolicy;
      }
      return teamConfig?.tools;
    }
  }
  return void 0;
}
function resolveMSTeamsAllowlistMatch(params) {
  return resolveAllowlistMatchSimple(params);
}
function resolveMSTeamsReplyPolicy(params) {
  if (params.isDirectMessage) {
    return { requireMention: false, replyStyle: "thread" };
  }
  const requireMention = params.channelConfig?.requireMention ?? params.teamConfig?.requireMention ?? params.globalConfig?.requireMention ?? true;
  const explicitReplyStyle = params.channelConfig?.replyStyle ?? params.teamConfig?.replyStyle ?? params.globalConfig?.replyStyle;
  const replyStyle = explicitReplyStyle ?? (requireMention ? "thread" : "top-level");
  return { requireMention, replyStyle };
}
function isMSTeamsGroupAllowed(params) {
  return evaluateSenderGroupAccessForPolicy({
    groupPolicy: params.groupPolicy,
    groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
    senderId: params.senderId,
    isSenderAllowed: () => resolveMSTeamsAllowlistMatch(params).allowed
  }).allowed;
}
export {
  isMSTeamsGroupAllowed,
  resolveMSTeamsAllowlistMatch,
  resolveMSTeamsGroupToolPolicy,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig
};
