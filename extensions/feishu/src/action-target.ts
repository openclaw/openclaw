import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { loadFeishuChannelRuntime } from "./channel-runtime-loader.js";
import { parseFeishuConversationId } from "./conversation-id.js";
import { resolveFeishuReplyMode } from "./outbound.js";
import { normalizeFeishuTarget } from "./targets.js";

export function readFirstString(
  params: Record<string, unknown>,
  keys: string[],
  fallback?: string | null,
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

export function resolveFeishuActionTarget(ctx: {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string } | null;
}): string | undefined {
  return readFirstString(ctx.params, ["to", "target"], ctx.toolContext?.currentChannelId);
}

export function resolveFeishuMessageId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["messageId", "message_id", "replyTo", "reply_to"]);
}

type FeishuActionReplyAnchor = {
  replyToMessageId: string | undefined;
  replyInThread: boolean;
};

type FeishuSendActionContext = Pick<
  ChannelMessageActionContext,
  "action" | "cfg" | "params" | "sessionKey" | "toolContext" | "requesterAccountId" | "reply"
>;

function isFeishuGroupTopicSessionKey(sessionKey: string | null | undefined): boolean {
  if (typeof sessionKey !== "string" || !sessionKey) {
    return false;
  }
  const parsed = parseFeishuConversationId({ conversationId: sessionKey });
  return parsed?.scope === "group_topic" || parsed?.scope === "group_topic_sender";
}

async function resolveFeishuTopicAutoThreadAnchor(
  ctx: FeishuSendActionContext,
  accountId: string,
): Promise<string | undefined> {
  const currentTarget =
    ctx.toolContext?.currentMessagingTarget ?? ctx.toolContext?.currentChannelId;
  const target = resolveFeishuActionTarget(ctx);
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
  const inbound = ctx.toolContext?.currentMessageId;
  if (typeof inbound === "string" && inbound.length > 0) {
    return inbound;
  }
  // Turns the agent starts on its own (heartbeat, scheduled work, tool sends) have no inbound
  // message, but the topic session still names the topic. Resolve that topic's root message so
  // the reply lands inside the topic instead of starting a new top-level topic.
  const sessionTopicId = parseFeishuConversationId({
    conversationId: ctx.sessionKey ?? "",
  })?.topicId?.trim();
  if (!sessionTopicId) {
    return undefined;
  }
  const runtime = await loadFeishuChannelRuntime();
  return await runtime.resolveFeishuReplyAnchorMessageId({
    cfg: ctx.cfg,
    threadId: sessionTopicId,
    accountId,
  });
}

export async function buildFeishuSendReplyAnchor(
  ctx: FeishuSendActionContext,
  accountId: string,
): Promise<FeishuActionReplyAnchor> {
  if (ctx.action === "thread-reply") {
    return {
      replyToMessageId: resolveFeishuMessageId(ctx.params),
      replyInThread: true,
    };
  }
  const threadId =
    readFirstString(ctx.params, ["threadId"]) ??
    (await resolveFeishuTopicAutoThreadAnchor(ctx, accountId));
  // Core also writes implicit reply IDs into params; they must not override
  // native topic delivery. Only an explicit reply can choose normal reply mode.
  const replyToId = ctx.reply
    ? ctx.reply.source === "implicit" && threadId
      ? undefined
      : ctx.reply.replyToId
    : readFirstString(ctx.params, ["replyTo", "reply_to"]);
  return resolveFeishuReplyMode({ replyToId, threadId });
}
