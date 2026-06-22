// Mattermost plugin module implements monitor gating behavior.
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

// Module-level cache mapping Mattermost channel IDs to their resolved ChatType.
// Populated by the monitor when channel info is fetched, consumed synchronously
// by inferTargetChatType so channel: targets can be resolved to the correct
// chat type (group for private channels, channel for public).
export const mattermostChannelKindCache = new Map<string, ChatType>();

/** Populate the channel kind cache (called by the Mattermost monitor). */
export function setMattermostChannelKindCache(
  channelId: string,
  channelType: string | null | undefined,
): void {
  mattermostChannelKindCache.set(channelId, mapMattermostChannelTypeToChatType(channelType));
}

export function mapMattermostChannelTypeToChatType(channelType?: string | null): ChatType {
  const normalized = channelType?.trim().toUpperCase();
  if (!normalized) {
    return "direct";
  }
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G" || normalized === "P") {
    return "group";
  }
  return "channel";
}

export function resolveMattermostTrustedChatKind(params: {
  channelType?: string | null;
  fallback?: ChatType;
}): ChatType {
  const channelType = params.channelType?.trim();
  if (channelType) {
    return mapMattermostChannelTypeToChatType(channelType);
  }
  return params.fallback ?? "direct";
}

export type MattermostRequireMentionResolverInput = {
  cfg: OpenClawConfig;
  channel: "mattermost";
  accountId: string;
  groupId: string;
  requireMentionOverride?: boolean;
};

export type MattermostMentionGateInput = {
  kind: ChatType;
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  threadRootId?: string;
  requireMentionOverride?: boolean;
  resolveRequireMention: (params: MattermostRequireMentionResolverInput) => boolean;
  wasMentioned: boolean;
  isControlCommand: boolean;
  commandAuthorized: boolean;
  oncharEnabled: boolean;
  oncharTriggered: boolean;
  canDetectMention: boolean;
};

type MattermostMentionGateDecision = {
  shouldRequireMention: boolean;
  shouldBypassMention: boolean;
  effectiveWasMentioned: boolean;
  dropReason: "onchar-not-triggered" | "missing-mention" | null;
};

export function evaluateMattermostMentionGate(
  params: MattermostMentionGateInput,
): MattermostMentionGateDecision {
  const shouldRequireMention =
    params.kind !== "direct" &&
    params.resolveRequireMention({
      cfg: params.cfg,
      channel: "mattermost",
      accountId: params.accountId,
      groupId: params.channelId,
      requireMentionOverride: params.requireMentionOverride,
    });
  const shouldBypassMention =
    params.isControlCommand &&
    shouldRequireMention &&
    !params.wasMentioned &&
    params.commandAuthorized;
  const effectiveWasMentioned =
    params.wasMentioned || shouldBypassMention || params.oncharTriggered;
  if (
    params.oncharEnabled &&
    !params.oncharTriggered &&
    !params.wasMentioned &&
    !params.isControlCommand
  ) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "onchar-not-triggered",
    };
  }
  if (
    params.kind !== "direct" &&
    shouldRequireMention &&
    params.canDetectMention &&
    !effectiveWasMentioned
  ) {
    return {
      shouldRequireMention,
      shouldBypassMention,
      effectiveWasMentioned,
      dropReason: "missing-mention",
    };
  }
  return {
    shouldRequireMention,
    shouldBypassMention,
    effectiveWasMentioned,
    dropReason: null,
  };
}
