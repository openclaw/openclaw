import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "../inbound.js";
import { wasMSTeamsMessageSent } from "../sent-message-cache.js";

/**
 * Determines whether an inbound Teams activity is an implicit mention —
 * i.e. a thread reply to a message the bot previously sent.
 *
 * Two lookup paths:
 *  1. `replyToId` directly references a bot-sent message.
 *  2. `conversation.id` contains `;messageid=<threadRootId>` pointing to a
 *     bot-sent (or bot-cached) thread root. This covers the case where Teams
 *     omits `replyToId` on thread replies.
 */
export function computeImplicitMention(activity: {
  conversation?: { id?: string };
  replyToId?: string;
}): boolean {
  const rawConversationId = activity.conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const replyToId = activity.replyToId ?? undefined;
  const threadRootId = extractMSTeamsConversationMessageId(rawConversationId);
  return Boolean(
    conversationId &&
    ((replyToId && wasMSTeamsMessageSent(conversationId, replyToId)) ||
      (threadRootId && wasMSTeamsMessageSent(conversationId, threadRootId))),
  );
}
