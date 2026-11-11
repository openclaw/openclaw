import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { loadFeishuChannelRuntime } from "./channel-runtime-loader.js";
import { parseFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuTarget } from "./targets.js";
import { normalizeFeishuNativeMessageId } from "./threading-reply.js";

type TopicAnchorContext = Pick<
  ChannelMessageActionContext,
  "cfg" | "params" | "sessionKey" | "toolContext" | "requesterAccountId"
>;

function isFeishuGroupTopicSessionKey(sessionKey: string | null | undefined): boolean {
  if (typeof sessionKey !== "string" || !sessionKey) {
    return false;
  }
  const parsed = parseFeishuConversationId({ conversationId: sessionKey });
  return parsed?.scope === "group_topic" || parsed?.scope === "group_topic_sender";
}

export async function resolveFeishuTopicAutoThreadAnchor(
  ctx: TopicAnchorContext,
  accountId: string,
  target: string | undefined,
): Promise<string | undefined> {
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
  const nativeAnchor =
    normalizeFeishuNativeMessageId(ctx.toolContext?.currentMessageId) ??
    normalizeFeishuNativeMessageId(ctx.toolContext?.currentThreadTs);
  if (nativeAnchor) {
    return nativeAnchor;
  }
  // Turns the agent starts on its own (heartbeat, scheduled work, tool sends) have no
  // inbound message, but the topic session still names the topic. A Feishu reply can
  // only address a message, so resolve that topic's root message to reply inside the
  // topic instead of starting a new top-level topic. The inferred anchor addresses a
  // message only, so the session's chat must be the requested destination.
  const sessionConversation = parseFeishuConversationId({ conversationId: ctx.sessionKey ?? "" });
  const sessionTopicId = sessionConversation?.topicId?.trim();
  const sessionChatId = sessionConversation?.chatId.split(":").at(-1);
  if (
    !sessionTopicId ||
    !sessionChatId ||
    normalizeFeishuTarget(sessionChatId) !== normalizeFeishuTarget(target)
  ) {
    return undefined;
  }
  const runtime = await loadFeishuChannelRuntime();
  return await runtime.resolveFeishuReplyAnchorMessageId({
    cfg: ctx.cfg,
    threadId: sessionTopicId,
    accountId,
  });
}
