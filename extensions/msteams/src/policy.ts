import { resolveScopeToolsPolicy } from "openclaw/plugin-sdk/channel-policy";
import type {
  ChannelGroupContext,
  GroupToolPolicyConfig,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../runtime-api.js";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../runtime-api.js";

function matchMSTeamsPolicyEntry<T>(entries: Record<string, T>, ...keys: (string | undefined)[]) {
  return resolveChannelEntryMatchWithFallback({
    entries,
    keys: buildChannelKeyCandidates(...keys),
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
}

function selectMSTeamsPolicyEntry<T>(entries: Record<string, T>, key?: string | null) {
  const match = matchMSTeamsPolicyEntry(entries, key?.trim());
  return (match.matchKey ?? match.key) ? match.entry : undefined;
}

export function resolveMSTeamsRouteConfig(params: {
  cfg?: MSTeamsConfig;
  teamId?: string | null | undefined;
  teamName?: string | null | undefined;
  conversationId?: string | null | undefined;
  channelName?: string | null | undefined;
  allowNameMatching?: boolean;
}) {
  const teamId = params.teamId?.trim();
  const teamName = params.teamName?.trim();
  const conversationId = params.conversationId?.trim();
  const channelName = params.channelName?.trim();
  const teams = params.cfg?.teams ?? {};
  const allowlistConfigured = Object.keys(teams).length > 0;
  const teamMatch = matchMSTeamsPolicyEntry(
    teams,
    teamId,
    params.allowNameMatching ? teamName : undefined,
    params.allowNameMatching && teamName ? normalizeChannelSlug(teamName) : undefined,
  );
  const teamConfig = teamMatch.entry;
  const channels = teamConfig?.channels ?? {};
  const channelAllowlistConfigured = Object.keys(channels).length > 0;
  const channelMatch = matchMSTeamsPolicyEntry(
    channels,
    conversationId,
    params.allowNameMatching ? channelName : undefined,
    params.allowNameMatching && channelName ? normalizeChannelSlug(channelName) : undefined,
  );
  const channelConfig = channelMatch.entry;

  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(teamConfig),
    innerConfigured: channelAllowlistConfigured,
    innerMatched: Boolean(channelConfig),
  });

  return {
    teamConfig,
    channelConfig,
    allowlistConfigured,
    allowed,
    teamKey: teamMatch.matchKey ?? teamMatch.key,
    channelKey: channelMatch.matchKey ?? channelMatch.key,
    channelMatchKey: channelMatch.matchKey,
    channelMatchSource:
      channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard"
        ? channelMatch.matchSource
        : undefined,
  };
}

export function resolveMSTeamsGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.msteams;
  if (!cfg) {
    return undefined;
  }
  const teams = cfg.teams ?? {};
  const team = selectMSTeamsPolicyEntry(teams, params.groupSpace);
  const channel = team && selectMSTeamsPolicyEntry(team.channels ?? {}, params.groupId);
  // Only selected nodes participate in policy resolution; fixed local keys avoid
  // materializing the whole config tree or encoding user-provided scope names.
  const resolve = (selectedTeam?: MSTeamsTeamConfig, selectedChannel?: MSTeamsChannelConfig) =>
    resolveScopeToolsPolicy({
      tree: { scopes: { team: selectedTeam ?? {}, channel: selectedChannel ?? {} } },
      path: ["team", "channel"],
      // No messageProvider: channel-prefixed sender keys were historically dead here.
      senderPolicyMode: params.senderPolicyMode,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
  const resolved = resolve(team, channel);
  // A policy-less team falls through to the first cross-team channel match;
  // a matched channel never does, even when neither selected node has policy.
  if (resolved !== undefined || channel) {
    return resolved;
  }
  if (params.groupId?.trim()) {
    for (const candidate of Object.values(teams)) {
      const matched = selectMSTeamsPolicyEntry(candidate.channels ?? {}, params.groupId);
      if (matched) {
        return resolve(candidate, matched);
      }
    }
  }
  return undefined;
}

type MSTeamsReplyPolicy = {
  requireMention: boolean;
  requireMentionInBotThreads?: boolean;
  replyStyle: MSTeamsReplyStyle;
};

export function resolveMSTeamsReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: MSTeamsConfig;
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
}): MSTeamsReplyPolicy {
  if (params.isDirectMessage) {
    return { requireMention: false, replyStyle: "thread" };
  }

  const requireMention =
    params.channelConfig?.requireMention ??
    params.teamConfig?.requireMention ??
    params.globalConfig?.requireMention ??
    true;

  const explicitReplyStyle =
    params.channelConfig?.replyStyle ??
    params.teamConfig?.replyStyle ??
    params.globalConfig?.replyStyle;
  const requireMentionInBotThreads =
    params.channelConfig?.requireMentionInBotThreads ??
    params.teamConfig?.requireMentionInBotThreads ??
    params.globalConfig?.requireMentionInBotThreads;

  const replyStyle: MSTeamsReplyStyle =
    explicitReplyStyle ?? (requireMention ? "thread" : "top-level");

  return {
    requireMention,
    replyStyle,
    ...(requireMentionInBotThreads === undefined ? {} : { requireMentionInBotThreads }),
  };
}
