// Mattermost plugin module implements monitor gating behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostPost } from "./client.js";
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

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
  /** True when the post replies to a thread the bot authored; bypasses the mention requirement. */
  replyToBot?: boolean;
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
  const replyToBot = params.replyToBot === true;
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
    params.wasMentioned || shouldBypassMention || params.oncharTriggered || replyToBot;
  if (
    params.oncharEnabled &&
    !params.oncharTriggered &&
    !params.wasMentioned &&
    !params.isControlCommand &&
    !replyToBot
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

/**
 * Reply-to-bot detection for Mattermost. Threads are flat: a reply carries only
 * `root_id` (the thread root) — the legacy `parent_id` was removed from the post
 * model — so replying "to the bot" means the bot authored the thread root. The
 * `posted` websocket payload omits the root author, so the caller injects a
 * fetcher that is consulted only when a thread root id is present.
 */
export async function resolveMattermostReplyToBot(params: {
  threadRootId?: string;
  botUserId: string;
  fetchRootPost: (postId: string) => Promise<MattermostPost | null>;
}): Promise<boolean> {
  const rootPostId = normalizeOptionalString(params.threadRootId);
  if (!rootPostId) {
    return false;
  }
  const rootPost = await params.fetchRootPost(rootPostId);
  return normalizeOptionalString(rootPost?.user_id) === params.botUserId;
}
