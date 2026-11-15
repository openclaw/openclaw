import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { parseFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuTarget } from "./targets.js";
import { normalizeFeishuNativeMessageId } from "./threading-reply.js";

type TopicAnchorContext = Pick<
  ChannelMessageActionContext,
  "params" | "sessionKey" | "toolContext" | "requesterAccountId"
>;

function isFeishuGroupTopicSessionKey(sessionKey: string | null | undefined): boolean {
  if (typeof sessionKey !== "string" || !sessionKey) {
    return false;
  }
  const parsed = parseFeishuConversationId({ conversationId: sessionKey });
  return parsed?.scope === "group_topic" || parsed?.scope === "group_topic_sender";
}

export function resolveFeishuTopicAutoThreadAnchor(
  ctx: TopicAnchorContext,
  accountId: string,
  target: string | undefined,
): string | undefined {
  const currentTarget =
    ctx.toolContext?.currentMessagingTarget ?? ctx.toolContext?.currentChannelId;
  // A reply API addresses only the message ID: inheriting it across targets
  // would send into the source topic while reporting the requested destination.
  if (
    !isFeishuGroupTopicSessionKey(ctx.sessionKey) ||
    ctx.params.topLevel === true ||
    ctx.params.threadId === null ||
    (ctx.requesterAccountId && ctx.requesterAccountId !== accountId) ||
    (ctx.toolContext?.currentChannelProvider &&
      ctx.toolContext.currentChannelProvider !== "feishu") ||
    !currentTarget ||
    !target ||
    normalizeFeishuTarget(currentTarget) !== normalizeFeishuTarget(target)
  ) {
    return undefined;
  }
  // Synthetic trigger IDs are rejected as reply anchors, but the topic root
  // stays valid for the message tool: keep sends inside the topic.
  return (
    normalizeFeishuNativeMessageId(ctx.toolContext?.currentMessageId) ??
    normalizeFeishuNativeMessageId(ctx.toolContext?.currentThreadTs)
  );
}
