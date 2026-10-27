import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { SlackActionContext } from "./action-context.js";
import { slackContextTargetsMatch } from "./targets.js";

export const SLACK_PRIVATE_ACTION_DELIVERY_RESULT = Symbol("slack.action.delivery-result");

export function resolveSlackAutoThreadId(params: {
  to: string;
  toolContext?: SlackActionContext;
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentChannelId && !context?.currentMessagingTarget) {
    return undefined;
  }
  if (!slackContextTargetsMatch(params.to, context)) {
    return undefined;
  }
  if (!context.currentThreadTs) {
    if (context.sameChannelThreadRequired) {
      throw new Error(
        "Slack thread context is required for same-channel replies from a threaded Slack turn. Set topLevel=true or threadId=null to post at the channel root.",
      );
    }
    return undefined;
  }
  if (context.replyToMode !== "all" && !isSingleUseReplyToMode(context.replyToMode ?? "off")) {
    return undefined;
  }
  if (isSingleUseReplyToMode(context.replyToMode ?? "off") && context.hasRepliedRef?.value) {
    return undefined;
  }
  return context.currentThreadTs;
}

export function resolveSlackThreadTsFromContext(
  explicitThreadTs: string | undefined,
  targetChannel: string,
  context: SlackActionContext | undefined,
  opts?: { suppressImplicitThread?: boolean },
): string | undefined {
  if (explicitThreadTs) {
    return explicitThreadTs;
  }
  if (opts?.suppressImplicitThread) {
    return undefined;
  }
  const threadTs = resolveSlackAutoThreadId({ to: targetChannel, toolContext: context });
  if (isSingleUseReplyToMode(context?.replyToMode ?? "off") && !context?.hasRepliedRef) {
    return undefined;
  }
  // Planning stays pure so failed sends cannot consume a thread before delivery.
  return threadTs;
}
