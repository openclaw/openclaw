import type { ChannelReactionContext } from "openclaw/plugin-sdk/channel-inbound";
import { resolveSignalReplyContextWithPersistence } from "../reply-authors.js";
import type { SignalInboundEntry } from "./event-handler.control-lane.js";
import type { SignalReactionMessage } from "./event-handler.types.js";
import { resolveSignalQuoteContext } from "./inbound-context.js";
import type { resolveSignalReactionTargets } from "./reactions.js";

type ReactionEntry = Pick<
  SignalInboundEntry,
  | "cfg"
  | "senderName"
  | "senderDisplay"
  | "senderRecipient"
  | "senderPeerId"
  | "groupId"
  | "groupName"
  | "isGroup"
  | "turnAdoptionLifecycle"
  | "resolveChannelIngress"
>;

/** Complete an already-authorized reaction through ordinary channel admission. */
export async function dispatchSignalReactionConversation(params: {
  accountId: string;
  reaction: SignalReactionMessage;
  emojiLabel: string;
  timestamp?: number | null;
  targets: ReturnType<typeof resolveSignalReactionTargets>;
  route: { agentId: string; sessionKey: string };
  effectiveGroupAllow: string[];
  entry: ReactionEntry;
  dispatch: (entry: SignalInboundEntry) => Promise<void>;
}): Promise<{ kind: "deferred" } | undefined> {
  const { accountId, reaction, timestamp, targets, route, entry } = params;
  // A target timestamp identifies a message, not a reaction occurrence. Never
  // mint a fresh identity for replay/history lacking a transport timestamp.
  if (!Number.isSafeInteger(timestamp) || !timestamp || timestamp <= 0) {
    return undefined;
  }
  const senderId = entry.senderPeerId;
  if (senderId.length > 100 || (entry.groupId?.length ?? 0) > 256) {
    return undefined;
  }
  const reactionMessageId = reaction.targetSentTimestamp
    ? String(reaction.targetSentTimestamp)
    : "unknown";
  const occurrenceId = JSON.stringify([accountId, senderId, timestamp]);
  const target = await resolveSignalReplyContextWithPersistence({
    accountId,
    to: entry.groupId ? `group:${entry.groupId}` : `signal:${entry.senderRecipient}`,
    replyToId: reactionMessageId,
  });
  const targetAuthor = targets[0]?.display;
  const targetQuote = resolveSignalQuoteContext({
    cfg: entry.cfg,
    accountId,
    isGroup: entry.isGroup,
    effectiveGroupAllow: params.effectiveGroupAllow,
    dataMessage: {
      quote: {
        author: reaction.targetAuthor,
        authorUuid: reaction.targetAuthorUuid,
        text:
          target &&
          !target.ambiguous &&
          targets.some(
            (candidate) => candidate.display === target.author || candidate.id === target.author,
          )
            ? target.body?.slice(0, 2000)
            : undefined,
      },
    },
  });
  const context: ChannelReactionContext = {
    channel: "signal",
    accountId,
    conversationId: entry.groupId ?? entry.senderRecipient,
    actorId: senderId,
    occurrenceId,
    action: reaction.isRemove ? "removed" : "added",
    emoji: params.emojiLabel.slice(0, 100),
    target: {
      messageId: reactionMessageId,
      authorId: targetAuthor,
      ...(targetQuote.visibleQuoteText ? { body: targetQuote.visibleQuoteText } : {}),
    },
  };
  const messageId = `reaction:${occurrenceId}`;
  const channelIngress = await entry.resolveChannelIngress({
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    messageId,
    inboundEventKind: "room_event",
  });
  if (!channelIngress.senderAccess.allowed) {
    return undefined;
  }
  const reactionBody = `Conversational reaction (not approval or task acceptance): ${JSON.stringify(context)}`;
  await params.dispatch({
    ...entry,
    bodyText: reactionBody,
    commandBody: reactionBody,
    commandAuthorized: false,
    messageId,
    timestamp,
    reaction: context,
    channelIngress: [channelIngress],
  });
  return entry.turnAdoptionLifecycle ? { kind: "deferred" } : undefined;
}
