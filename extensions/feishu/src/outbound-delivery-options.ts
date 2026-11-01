// Feishu plugin module owns the delivery-scoped context a text fanout has to carry.
import type { FeishuSendTextContext } from "./outbound-send-result.js";

/**
 * What every sender behind one delivery forwards to each message it sends itself: the
 * reply-target policy, the delivery reporting, the cancellation signal, and the
 * per-delivery formatting that sizes the cut.
 *
 * Send authority is not in here: the ambient send scope established once around the
 * adapter call owns it, and the client revalidates it per request. One owner because the
 * chat, comment, media and fallback senders all forward these and a subset silently
 * dropped at one of them is invisible: the message still goes out, only uncancelled or
 * cut to the wrong size.
 */
export type FeishuOutboundDeliveryOptions = Pick<
  FeishuSendTextContext,
  "replyToIdSource" | "replyToMode" | "onDeliveryResult" | "signal" | "formatting"
>;

/** Narrows a send context to the fields above, so a sender forwards them whole. */
export function feishuOutboundDeliveryOptions(
  ctx: FeishuOutboundDeliveryOptions,
): FeishuOutboundDeliveryOptions {
  return {
    replyToIdSource: ctx.replyToIdSource,
    replyToMode: ctx.replyToMode,
    onDeliveryResult: ctx.onDeliveryResult,
    signal: ctx.signal,
    formatting: ctx.formatting,
  };
}
