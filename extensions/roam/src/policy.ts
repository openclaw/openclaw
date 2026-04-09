import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupPolicy,
  GroupToolPolicyConfig,
} from "../runtime-api.js";
import {
  buildChannelKeyCandidates,
  evaluateMatchedGroupAccessForPolicy,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveMentionGatingWithBypass,
  resolveNestedAllowlistDecision,
} from "../runtime-api.js";
import type { RoamGroupConfig } from "./types.js";

function normalizeAllowEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(roam|roam-hq):/i, "");
}

export function normalizeRoamAllowlist(values: Array<string | number> | undefined): string[] {
  return (values ?? []).map((value) => normalizeAllowEntry(String(value))).filter(Boolean);
}

export function resolveRoamAllowlistMatch(params: {
  allowFrom: Array<string | number> | undefined;
  senderId: string;
}): AllowlistMatch<"wildcard" | "id"> {
  const allowFrom = normalizeRoamAllowlist(params.allowFrom);
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

export type RoamGroupMatch = {
  groupConfig?: RoamGroupConfig;
  wildcardConfig?: RoamGroupConfig;
  groupKey?: string;
  matchSource?: "direct" | "parent" | "wildcard";
  allowed: boolean;
  allowlistConfigured: boolean;
};

export function resolveRoamGroupMatch(params: {
  groups?: Record<string, RoamGroupConfig>;
  chatId: string;
}): RoamGroupMatch {
  const groups = params.groups ?? {};
  const allowlistConfigured = Object.keys(groups).length > 0;
  const groupCandidates = buildChannelKeyCandidates(params.chatId);
  const match = resolveChannelEntryMatchWithFallback({
    entries: groups,
    keys: groupCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const groupConfig = match.entry;
  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(groupConfig),
    innerConfigured: false,
    innerMatched: false,
  });

  return {
    groupConfig,
    wildcardConfig: match.wildcardEntry,
    groupKey: match.matchKey ?? match.key,
    matchSource: match.matchSource,
    allowed,
    allowlistConfigured,
  };
}

export function resolveRoamGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg as {
    channels?: { roam?: { groups?: Record<string, RoamGroupConfig> } };
  };
  const chatId = params.groupId?.trim();
  if (!chatId) {
    return undefined;
  }
  const match = resolveRoamGroupMatch({
    groups: cfg.channels?.roam?.groups,
    chatId,
  });
  return match.groupConfig?.tools ?? match.wildcardConfig?.tools;
}

export function resolveRoamRequireMention(params: {
  groupConfig?: RoamGroupConfig;
  wildcardConfig?: RoamGroupConfig;
}): boolean {
  if (typeof params.groupConfig?.requireMention === "boolean") {
    return params.groupConfig.requireMention;
  }
  if (typeof params.wildcardConfig?.requireMention === "boolean") {
    return params.wildcardConfig.requireMention;
  }
  return true;
}

export function resolveRoamGroupAllow(params: {
  groupPolicy: GroupPolicy;
  outerAllowFrom: Array<string | number> | undefined;
  innerAllowFrom: Array<string | number> | undefined;
  senderId: string;
}): { allowed: boolean; outerMatch: AllowlistMatch; innerMatch: AllowlistMatch } {
  const outerAllow = normalizeRoamAllowlist(params.outerAllowFrom);
  const innerAllow = normalizeRoamAllowlist(params.innerAllowFrom);
  const outerMatch = resolveRoamAllowlistMatch({
    allowFrom: params.outerAllowFrom,
    senderId: params.senderId,
  });
  const innerMatch = resolveRoamAllowlistMatch({
    allowFrom: params.innerAllowFrom,
    senderId: params.senderId,
  });
  const access = evaluateMatchedGroupAccessForPolicy({
    groupPolicy: params.groupPolicy,
    allowlistConfigured: outerAllow.length > 0 || innerAllow.length > 0,
    allowlistMatched: resolveNestedAllowlistDecision({
      outerConfigured: outerAllow.length > 0 || innerAllow.length > 0,
      outerMatched: outerAllow.length > 0 ? outerMatch.allowed : true,
      innerConfigured: innerAllow.length > 0,
      innerMatched: innerMatch.allowed,
    }),
  });

  return {
    allowed: access.allowed,
    outerMatch:
      params.groupPolicy === "open"
        ? { allowed: true }
        : params.groupPolicy === "disabled"
          ? { allowed: false }
          : outerMatch,
    innerMatch:
      params.groupPolicy === "open"
        ? { allowed: true }
        : params.groupPolicy === "disabled"
          ? { allowed: false }
          : innerMatch,
  };
}

export function resolveRoamMentionGate(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}): { shouldSkip: boolean; shouldBypassMention: boolean } {
  const result = resolveMentionGatingWithBypass({
    isGroup: params.isGroup,
    requireMention: params.requireMention,
    canDetectMention: true,
    wasMentioned: params.wasMentioned,
    allowTextCommands: params.allowTextCommands,
    hasControlCommand: params.hasControlCommand,
    commandAuthorized: params.commandAuthorized,
  });
  return { shouldSkip: result.shouldSkip, shouldBypassMention: result.shouldBypassMention };
}
