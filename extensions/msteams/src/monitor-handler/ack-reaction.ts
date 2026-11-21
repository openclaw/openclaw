import { shouldAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "../../runtime-api.js";
import { formatUnknownError } from "../errors.js";
import { reactMessageMSTeams } from "../graph-messages.js";
import type { MSTeamsMonitorLogger } from "../monitor-types.js";

type MSTeamsAckReactionParams = {
  cfg: OpenClawConfig;
  accountId: string;
  log: MSTeamsMonitorLogger;
  messageId: string | undefined;
  conversationId: string;
  isDirectMessage: boolean;
  isChannel: boolean;
  /** `teamAadGroupId/graphChannelId`; Graph addresses channel messages only through it. */
  nativeChannelId: string | undefined;
  threadRootId: string | undefined;
  effectiveWasMentioned: boolean;
};

function resolveMSTeamsAckTarget(
  params: MSTeamsAckReactionParams,
): { to: string; threadRootId?: string } | undefined {
  if (params.isChannel) {
    return params.nativeChannelId
      ? { to: params.nativeChannelId, threadRootId: params.threadRootId }
      : undefined;
  }
  // Graph accepts only native `19:` chat ids. Personal chats usually carry a Bot
  // Framework `a:` id, so those direct messages have no reaction target.
  return params.conversationId.startsWith("19:")
    ? { to: `conversation:${params.conversationId}` }
    : undefined;
}

/**
 * Send the configured acknowledgement for an admitted Teams turn. Only an explicit
 * `messages.ackReaction` opts in: Graph reaction writes need delegated auth that most
 * Teams accounts lack, so the agent identity fallback would fail on every turn.
 * The reaction stays on the message; failures never block the turn.
 */
export function sendMSTeamsAckReaction(params: MSTeamsAckReactionParams): void {
  const reactionType = params.cfg.messages?.ackReaction?.trim();
  if (!reactionType || !params.messageId) {
    return;
  }
  const admitted = shouldAckReaction({
    scope: params.cfg.messages?.ackReactionScope,
    inboundEventKind: "user_request",
    isDirect: params.isDirectMessage,
    isGroup: !params.isDirectMessage,
    isMentionableGroup: !params.isDirectMessage,
    canDetectMention: true,
    effectiveWasMentioned: params.effectiveWasMentioned,
  });
  if (!admitted) {
    return;
  }
  const target = resolveMSTeamsAckTarget(params);
  if (!target) {
    params.log.debug?.("skipping ack reaction (no Graph message target)", {
      conversationId: params.conversationId,
    });
    return;
  }
  const messageId = params.messageId;
  reactMessageMSTeams({
    cfg: params.cfg,
    accountId: params.accountId,
    to: target.to,
    messageId,
    ...(target.threadRootId ? { threadRootId: target.threadRootId } : {}),
    reactionType,
  }).catch((err: unknown) => {
    params.log.warn?.("ack reaction failed", {
      conversationId: params.conversationId,
      messageId,
      error: formatUnknownError(err),
    });
  });
}
