import { recordChannelFeedbackEvent } from "openclaw/plugin-sdk/channel-inbound";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatUnknownError } from "./errors.js";
import { buildFeedbackEvent, runFeedbackReflection } from "./feedback-reflection.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { isMSTeamsInvokeAuthorized } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

/** Return whether feedback consumed the invoke; the SDK owns its HTTP acknowledgement. */
export async function runMSTeamsFeedbackInvokeHandler(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  const activity = context.activity;
  const value = activity.value as
    | {
        actionName?: string;
        actionValue?: { reaction?: string; feedback?: string };
        replyToId?: string;
      }
    | undefined;

  if (!value) {
    return false;
  }

  if (value.actionName !== "feedback") {
    return false;
  }

  const reaction = value.actionValue?.reaction;
  if (reaction !== "like" && reaction !== "dislike") {
    deps.log.debug?.("ignoring feedback with unknown reaction", { reaction });
    return false;
  }

  const msteamsCfg = deps.cfg.channels?.msteams;
  if (msteamsCfg?.feedbackEnabled === false) {
    deps.log.debug?.("feedback handling disabled");
    return true;
  }

  if (!(await isMSTeamsInvokeAuthorized({ context, deps, invokeKind: "feedback" }))) {
    return true;
  }

  let userComment: string | undefined;
  if (value.actionValue?.feedback) {
    try {
      const parsed = JSON.parse(value.actionValue.feedback) as { feedbackText?: string };
      userComment = parsed.feedbackText || undefined;
    } catch {
      // Best effort — feedback text is optional
    }
  }

  const rawConversationId = activity.conversation?.id ?? "unknown";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const messageId = value.replyToId ?? activity.replyToId ?? "unknown";
  const isNegative = reaction === "dislike";

  // Match normal-message routing so feedback reaches the same session.
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const isChannel = convType === "channel";

  const core = getMSTeamsRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: "msteams",
    peer: {
      kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      id: isDirectMessage ? senderId : conversationId,
    },
  });

  const feedbackThreadId = isChannel
    ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId ?? undefined)
    : undefined;
  if (feedbackThreadId) {
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey: route.sessionKey,
      threadId: feedbackThreadId,
      parentSessionKey: route.sessionKey,
    });
    route.sessionKey = threadKeys.sessionKey;
  }

  const feedbackEvent = buildFeedbackEvent({
    messageId,
    value: isNegative ? "negative" : "positive",
    comment: userComment,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    conversationId,
  });

  deps.log.info("received feedback", {
    value: feedbackEvent.value,
    messageId,
    conversationId,
    hasComment: Boolean(userComment),
  });

  try {
    await recordChannelFeedbackEvent({
      cfg: deps.cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      event: feedbackEvent,
    });
  } catch {
    // Best effort
  }

  const conversationRef = {
    activityId: activity.id,
    user: {
      id: activity.from?.id,
      name: activity.from?.name,
      aadObjectId: activity.from?.aadObjectId,
    },
    agent: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    conversation: {
      id: conversationId,
      conversationType: activity.conversation?.conversationType,
      tenantId: activity.conversation?.tenantId,
    },
    channelId: activity.channelId ?? "msteams",
    serviceUrl: activity.serviceUrl,
    locale: activity.locale,
  };

  // Sending during the invoke causes "unable to reach app" errors; reflection responds later.
  if (isNegative && msteamsCfg?.feedbackReflection !== false) {
    // Sent text is not cached; reflection uses the session history and optional user comment.
    runFeedbackReflection({
      cfg: deps.cfg,
      app: deps.app,
      conversationRef,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      conversationId,
      conversationKind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      userComment,
      log: deps.log,
    }).catch((err: unknown) => {
      deps.log.error("feedback reflection failed", { error: formatUnknownError(err) });
    });
  }

  return true;
}
