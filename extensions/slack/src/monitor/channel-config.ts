import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import {
  applyChannelMatchMeta,
  buildChannelKeyCandidates,
  type ChannelMatchSource,
} from "openclaw/plugin-sdk/channel-targets";
import type { SlackChannelConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { buildSlackChannelIdCandidates, buildSlackChannelPolicyScope } from "../group-policy.js";
import { normalizeSlackSlug, resolveSlackUserAllowListForTeam } from "./allow-list.js";

type SlackChannelConfigEntry = Omit<SlackChannelConfig, "tools" | "toolsBySender">;

export type SlackChannelConfigResolved = Omit<
  SlackChannelConfigEntry,
  "enabled" | "requireMention"
> & {
  allowed: boolean;
  requireMention: boolean;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

export type SlackChannelConfigEntries = Record<string, SlackChannelConfigEntry>;

export function resolveSlackChannelLabel(params: { channelId?: string; channelName?: string }) {
  const channelName = params.channelName?.trim();
  if (channelName) {
    const slug = normalizeSlackSlug(channelName);
    return `#${slug || channelName}`;
  }
  const channelId = params.channelId?.trim();
  return channelId ? `#${channelId}` : "unknown channel";
}

export function resolveSlackChannelConfig(params: {
  teamId?: string;
  allowUnscoped?: boolean;
  channelId: string;
  channelName?: string;
  channels?: SlackChannelConfigEntries;
  channelKeys?: string[];
  defaultRequireMention?: boolean;
  allowNameMatching?: boolean;
}): SlackChannelConfigResolved | null {
  const {
    channelId,
    channelName,
    channels,
    channelKeys,
    defaultRequireMention,
    allowNameMatching,
  } = params;
  const entries = channels ?? {};
  const keys = channelKeys ?? Object.keys(entries);
  const normalizedName = channelName ? normalizeSlackSlug(channelName) : "";
  const directName = channelName ? channelName.trim() : "";
  const candidates = buildChannelKeyCandidates(
    ...buildSlackChannelIdCandidates(channelId, params.teamId, {
      allowUnscoped: params.allowUnscoped,
    }),
    allowNameMatching ? (channelName ? `#${directName}` : undefined) : undefined,
    allowNameMatching ? directName : undefined,
    allowNameMatching ? normalizedName : undefined,
  );
  const match = buildSlackChannelPolicyScope({ channels: entries, candidates });
  const { entry: matched, wildcardEntry: fallback } = match;

  // The monitor honors root channels.slack.requireMention; the adapter deliberately ignores it.
  const requireMentionDefault = defaultRequireMention ?? true;
  if (keys.length === 0) {
    return { allowed: true, requireMention: requireMentionDefault };
  }
  if (!matched && !fallback) {
    return { allowed: false, requireMention: requireMentionDefault };
  }

  const resolved = matched ?? fallback ?? {};
  const allowed = firstDefined(resolved.enabled, fallback?.enabled, true) ?? true;
  const requireMention =
    firstDefined(resolved.requireMention, fallback?.requireMention, requireMentionDefault) ??
    requireMentionDefault;
  const requireMentionInBotThreads = firstDefined(
    resolved.requireMentionInBotThreads,
    fallback?.requireMentionInBotThreads,
  );
  const ignoreOtherMentions = firstDefined(
    resolved.ignoreOtherMentions,
    fallback?.ignoreOtherMentions,
  );
  const allowBots = firstDefined(resolved.allowBots, fallback?.allowBots);
  const replyToMode = firstDefined(resolved.replyToMode, fallback?.replyToMode);
  const botLoopProtection = mergePairLoopGuardConfig(
    fallback?.botLoopProtection,
    matched?.botLoopProtection,
  );
  const users = resolveSlackUserAllowListForTeam({
    allowList: firstDefined(resolved.users, fallback?.users),
    teamId: params.teamId,
    // Keeping unmatched entries preserves the configured allowlist gate;
    // ingress treats differently scoped values as non-matching.
    preserveUnmatchedScopedEntries: true,
  });
  const skills = firstDefined(resolved.skills, fallback?.skills);
  const systemPrompt = firstDefined(resolved.systemPrompt, fallback?.systemPrompt);
  const presenceEvents = firstDefined(resolved.presenceEvents, fallback?.presenceEvents);
  const result: SlackChannelConfigResolved = {
    allowed,
    requireMention,
    requireMentionInBotThreads,
    ignoreOtherMentions,
    replyToMode,
    allowBots,
    botLoopProtection,
    users: users.length > 0 ? users : undefined,
    skills,
    systemPrompt,
    presenceEvents,
  };
  return applyChannelMatchMeta(result, match);
}
