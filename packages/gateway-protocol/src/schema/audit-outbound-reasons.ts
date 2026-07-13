import { Type } from "typebox";

/** V1 reason codes for intentionally suppressed outbound messages. */
export const AuditOutboundSuppressedReasonSchema = Type.Union([
  Type.Literal("cancelled_by_message_sending_hook"),
  Type.Literal("cancelled_by_outbound_delivery_policy"),
  Type.Literal("cancelled_by_reply_payload_sending_hook"),
  Type.Literal("empty_after_message_sending_hook"),
  Type.Literal("empty_after_reply_payload_sending_hook"),
  Type.Literal("no_visible_payload"),
]);
