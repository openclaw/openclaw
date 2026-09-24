import type { ChannelBotLoopProtectionConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import type { ClickClackGroupConfig } from "./types.js";

type ClickClackGroupPolicy = {
  requireMention: boolean;
  requireMentionInBotThreads?: boolean;
  mentionPatterns: string[];
  allowBots: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
};

export function resolveClickClackGroupPolicy(params: {
  account: ClickClackGroupConfig & { groups?: Record<string, ClickClackGroupConfig> };
  channelId?: string;
}): ClickClackGroupPolicy {
  const { account, channelId } = params;
  const channelKey = channelId?.trim();
  // Group-scoped policy must not affect direct messages, which have no
  // channel ID. In particular, groups["*"] is a channel fallback, not an
  // account-wide override.
  const groups = channelKey ? account.groups : undefined;
  const wildcard = groups?.["*"];
  const exact = channelKey ? groups?.[channelKey] : undefined;
  return {
    requireMention:
      exact?.requireMention ?? wildcard?.requireMention ?? account.requireMention === true,
    requireMentionInBotThreads:
      exact?.requireMentionInBotThreads ??
      wildcard?.requireMentionInBotThreads ??
      account.requireMentionInBotThreads,
    mentionPatterns:
      exact?.mentionPatterns ?? wildcard?.mentionPatterns ?? account.mentionPatterns ?? [],
    allowBots: exact?.allowBots ?? wildcard?.allowBots ?? account.allowBots ?? false,
    botLoopProtection: mergePairLoopGuardConfig(
      account.botLoopProtection,
      wildcard?.botLoopProtection,
      exact?.botLoopProtection,
    ),
  };
}
