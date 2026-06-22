// Mattermost plugin module implements monitor gating behavior.
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

// Channel-kind cache TTL (5 min) matches the per-resource channelCache TTL
// in monitor-resources.ts so cached entries expire alongside their source.
const CHANNEL_KIND_CACHE_TTL_MS = 5 * 60_000;

type ChannelKindCacheEntry = {
  kind: ChatType;
  expiresAt: number;
};

// Per-account-scoped cache mapping Mattermost channel IDs to their resolved
// ChatType. Populated by the monitor when channel info is fetched, consumed
// synchronously by inferTargetChatType and resolveMattermostOutboundSessionRoute.
// Entries expire after CHANNEL_KIND_CACHE_TTL_MS to prevent stale or
// cross-account values from persisting beyond the source channel cache.
const channelKindStore = new Map<string, ChannelKindCacheEntry>();

function makeCacheKey(channelId: string, accountId?: string): string {
  return accountId ? `${accountId}:${channelId}` : channelId;
}

/** Read a cached channel kind, optionally scoped to an account. */
export function getMattermostChannelKind(
  channelId: string,
  accountId?: string,
): ChatType | undefined {
  const key = makeCacheKey(channelId, accountId);
  const entry = channelKindStore.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    channelKindStore.delete(key);
    return undefined;
  }
  return entry.kind;
}

/** Populate the channel kind cache (called by the Mattermost monitor). */
export function setMattermostChannelKindCache(
  channelId: string,
  channelType: string | null | undefined,
  accountId?: string,
): void {
  const key = makeCacheKey(channelId, accountId);
  channelKindStore.set(key, {
    kind: mapMattermostChannelTypeToChatType(channelType),
    expiresAt: Date.now() + CHANNEL_KIND_CACHE_TTL_MS,
  });
}

// Backward-compatible module-level facade so existing callers that used
// `mattermostChannelKindCache.get()` / `.set()` continue to work.
export const mattermostChannelKindCache = {
  get: (channelId: string, accountId?: string) => getMattermostChannelKind(channelId, accountId),
  set: (channelId: string, channelType: string | null | undefined, accountId?: string) =>
    setMattermostChannelKindCache(channelId, channelType, accountId),
};

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
