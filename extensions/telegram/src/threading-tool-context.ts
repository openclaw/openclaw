import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { telegramMessagingTargetsMatch } from "./normalize.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramConversationRef } from "./topic-conversation.js";

export function buildTelegramThreadingToolContext(params: {
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const currentChannelId = normalizeOptionalString(params.context.To);
  const threadId =
    params.context.MessageThreadId ??
    (currentChannelId ? parseTelegramTarget(currentChannelId).messageThreadId : undefined);
  return {
    currentChannelId,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    hasRepliedRef: params.hasRepliedRef,
  };
}

/**
 * The current conversation includes its topic: an explicit `chat:topic:N` send
 * from inside that topic is a source reply, as is the bare chat target.
 */
export function matchesTelegramToolContextTarget(params: {
  target: string;
  toolContext: ChannelThreadingToolContext;
}): boolean {
  const { target, toolContext } = params;
  return [toolContext.currentMessagingTarget, toolContext.currentChannelId].some((current) => {
    const threaded =
      current &&
      resolveTelegramConversationRef({ to: current, threadId: toolContext.currentThreadTs });
    return [current, threaded && threaded.conversationId].some(
      (candidate) => candidate && telegramMessagingTargetsMatch(target, candidate),
    );
  });
}
