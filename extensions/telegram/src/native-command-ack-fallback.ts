import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

export function shouldDeliverNativeCommandAckFallback(reply: ReplyPayload): boolean {
  const { trimmedText } = resolveSendableOutboundReplyParts(reply);
  if (!trimmedText) {
    return false;
  }
  // Command handlers (/compact, /status, /stop, …) emit user-initiated system feedback.
  return reply.isStatusNotice === true || trimmedText.startsWith("⚙️");
}

export async function deliverNativeCommandAckFallback(params: {
  reply: ReplyPayload | ReplyPayload[] | undefined;
  delivered: boolean;
  deliverReplies: (params: { replies: ReplyPayload[] }) => Promise<{ delivered: boolean }>;
  replyToMessageId: string;
}): Promise<boolean> {
  if (params.delivered || !params.reply) {
    return params.delivered;
  }
  const replies = Array.isArray(params.reply) ? params.reply : [params.reply];
  for (const original of replies) {
    if (!shouldDeliverNativeCommandAckFallback(original)) {
      continue;
    }
    const result = await params.deliverReplies({
      replies: [
        original.replyToId
          ? original
          : {
              ...original,
              replyToId: params.replyToMessageId,
            },
      ],
    });
    if (result.delivered) {
      return true;
    }
  }
  return false;
}
