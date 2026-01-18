import type {
  GroupPolicy,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../../../src/config/types.js";

export type MSTeamsResolvedRouteConfig = {
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
  allowlistConfigured: boolean;
  allowed: boolean;
  teamKey?: string;
  channelKey?: string;
  channelMatchKey?: string;
  channelMatchSource?: "direct" | "wildcard";
};

export function resolveMSTeamsRouteConfig(params: {
  cfg?: MSTeamsConfig;
  teamId?: string | null | undefined;
  teamName?: string | null | undefined;
  conversationId?: string | null | undefined;
  channelName?: string | null | undefined;
}): MSTeamsResolvedRouteConfig {
  const teamId = params.teamId?.trim();
  const teamName = params.teamName?.trim();
  const conversationId = params.conversationId?.trim();
  const channelName = params.channelName?.trim();
  const teams = params.cfg?.teams ?? {};
  const teamKeys = Object.keys(teams);
  const allowlistConfigured = teamKeys.length > 0;

  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^#/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  let teamKey: string | undefined;
  if (teamId && teams[teamId]) teamKey = teamId;
  if (!teamKey && teamName) {
    const slug = normalize(teamName);
    if (slug) {
      teamKey = teamKeys.find((key) => normalize(key) === slug);
    }
  }
  if (!teamKey && teams["*"]) teamKey = "*";

  const teamConfig = teamKey ? teams[teamKey] : undefined;
  const channels = teamConfig?.channels ?? {};
  const channelKeys = Object.keys(channels);

  let channelKey: string | undefined;
  if (conversationId && channels[conversationId]) channelKey = conversationId;
  if (!channelKey && channelName) {
    const slug = normalize(channelName);
    if (slug) {
      channelKey = channelKeys.find((key) => normalize(key) === slug);
    }
  }
  if (!channelKey && channels["*"]) channelKey = "*";
  const channelConfig = channelKey ? channels[channelKey] : undefined;
  const channelAllowlistConfigured = channelKeys.length > 0;

  const allowed = !allowlistConfigured
    ? true
    : Boolean(teamConfig) && (!channelAllowlistConfigured || Boolean(channelConfig));

  return {
    teamConfig,
    channelConfig,
    allowlistConfigured,
    allowed,
    teamKey,
    channelKey,
    channelMatchKey: channelKey,
    channelMatchSource: channelKey ? (channelKey === "*" ? "wildcard" : "direct") : undefined,
  };
}

export type MSTeamsReplyPolicy = {
  requireMention: boolean;
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

  const replyStyle: MSTeamsReplyStyle =
    explicitReplyStyle ?? (requireMention ? "thread" : "top-level");

  return { requireMention, replyStyle };
}

export function isMSTeamsGroupAllowed(params: {
  groupPolicy: GroupPolicy;
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  const allowFrom = params.allowFrom
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  if (allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const senderId = params.senderId.toLowerCase();
  const senderName = params.senderName?.toLowerCase();
  return allowFrom.includes(senderId) || (senderName ? allowFrom.includes(senderName) : false);
}
