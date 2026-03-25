/**
 * Group/channel access policy evaluation for Synology Chat.
 * Follows the same pattern as extensions/telegram/src/group-access.ts.
 */

import type { ResolvedSynologyChatAccount, SynologyChatChannelOverride } from "./types.js";

export type SynologyChatGroupAccessResult =
  | { allowed: true; groupPolicy: "open" | "allowlist" }
  | {
      allowed: false;
      reason: SynologyChatGroupBlockReason;
      groupPolicy: "open" | "disabled" | "allowlist";
    };

export type SynologyChatGroupBlockReason =
  | "group-policy-disabled"
  | "group-policy-allowlist-no-sender"
  | "group-policy-allowlist-empty"
  | "group-policy-allowlist-unauthorized";

/**
 * Resolve a channel override entry by channel_id or channel_name, falling
 * back to the wildcard "*" entry if no specific match is found.
 */
function resolveChannelOverride(
  channels: Record<string, SynologyChatChannelOverride> | undefined,
  channelId?: string,
  channelName?: string,
): SynologyChatChannelOverride | undefined {
  if (!channels || Object.keys(channels).length === 0) return undefined;
  // Try exact channel_id match first
  if (channelId && channels[channelId]) return channels[channelId];
  // Then try channel_name match
  if (channelName && channels[channelName]) return channels[channelName];
  // Fall back to wildcard
  return channels["*"];
}

/**
 * Evaluate whether a group/channel message should be accepted.
 * Resolution order: per-channel allowFrom > account groupAllowFrom > groupPolicy.
 */
export function evaluateSynologyChatGroupAccess(params: {
  account: ResolvedSynologyChatAccount;
  senderId?: string;
  channelId?: string;
  channelName?: string;
}): SynologyChatGroupAccessResult {
  const { account, senderId, channelId, channelName } = params;
  const groupPolicy = account.groupPolicy;

  if (groupPolicy === "disabled") {
    return { allowed: false, reason: "group-policy-disabled", groupPolicy };
  }

  if (groupPolicy === "open") {
    return { allowed: true, groupPolicy };
  }

  // groupPolicy === "allowlist"
  const channelOverride = resolveChannelOverride(account.channels, channelId, channelName);

  // Build the effective allowlist: per-channel override > account-level
  const effectiveAllowFrom = channelOverride?.allowFrom ?? account.groupAllowFrom;

  if (!senderId) {
    return { allowed: false, reason: "group-policy-allowlist-no-sender", groupPolicy };
  }

  if (effectiveAllowFrom.length === 0) {
    return { allowed: false, reason: "group-policy-allowlist-empty", groupPolicy };
  }

  const normalizedSender = senderId.toLowerCase().trim();
  const isAuthorized =
    effectiveAllowFrom.some((id) => id === "*") ||
    effectiveAllowFrom.some((id) => id.toLowerCase().trim() === normalizedSender);

  if (!isAuthorized) {
    return { allowed: false, reason: "group-policy-allowlist-unauthorized", groupPolicy };
  }

  return { allowed: true, groupPolicy };
}

/**
 * Resolve whether the bot must be @mentioned to respond in a channel.
 * Per-channel config > wildcard "*" > default (true).
 */
export function resolveSynologyChatGroupRequireMention(params: {
  account: ResolvedSynologyChatAccount;
  channelId?: string;
  channelName?: string;
}): boolean {
  const channelOverride = resolveChannelOverride(
    params.account.channels,
    params.channelId,
    params.channelName,
  );
  if (typeof channelOverride?.requireMention === "boolean") {
    return channelOverride.requireMention;
  }
  // Default: require mention in group contexts (safe default, like Discord/Telegram)
  return true;
}
