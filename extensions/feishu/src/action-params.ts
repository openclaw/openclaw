// Feishu message action parameters: shared reads and the message a reaction targets.
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeFeishuTarget } from "./targets.js";

export function readFirstString(
  params: Record<string, unknown>,
  keys: string[],
  fallback?: string | null,
): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(params[key]);
    if (value) {
      return value;
    }
  }
  return normalizeOptionalString(fallback);
}

export function resolveFeishuMessageId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["messageId", "message_id", "replyTo", "reply_to"]);
}

export /** Reactions default to the inbound message, but only in the conversation it arrived in. */
function resolveFeishuReactionMessageId(
  ctx: Pick<ChannelMessageActionContext, "params" | "toolContext" | "requesterAccountId">,
  accountId: string,
): string | undefined {
  const explicit = resolveFeishuMessageId(ctx.params);
  const inbound = ctx.toolContext?.currentMessageId;
  if (
    explicit ||
    typeof inbound !== "string" ||
    !inbound ||
    (ctx.requesterAccountId && ctx.requesterAccountId !== accountId) ||
    (ctx.toolContext?.currentChannelProvider && ctx.toolContext.currentChannelProvider !== "feishu")
  ) {
    return explicit;
  }
  const target = readFirstString(ctx.params, [
    "chatId",
    "chat_id",
    "channelId",
    "channel_id",
    "to",
    "target",
  ]);
  // A direct turn reports the chat as its channel and the sender as its messaging target.
  const current = [ctx.toolContext?.currentChannelId, ctx.toolContext?.currentMessagingTarget];
  if (
    target &&
    !current.some(
      (candidate) =>
        candidate && normalizeFeishuTarget(candidate) === normalizeFeishuTarget(target),
    )
  ) {
    return undefined;
  }
  return inbound;
}
