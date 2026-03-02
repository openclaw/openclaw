import { Type, type Static } from "@sinclair/typebox";

const URGENT_TYPE_VALUES = ["app", "sms", "phone"] as const;

export const FeishuUrgentSchema = Type.Object({
  message_id: Type.String({
    description: "Message ID to send urgent notification for (e.g. om_xxx)",
  }),
  user_ids: Type.Array(Type.String(), {
    description:
      "List of open_id values to buzz. The recipients must be members of the chat where the message was sent.",
    minItems: 1,
  }),
  urgent_type: Type.Optional(
    Type.Unsafe<(typeof URGENT_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...URGENT_TYPE_VALUES],
      description:
        "Urgency delivery method: app (in-app buzz, default), sms (SMS), phone (voice call). Note: sms and phone may incur cost on the tenant.",
      default: "app",
    }),
  ),
  account_id: Type.Optional(
    Type.String({ description: "Feishu account ID (uses default account if omitted)" }),
  ),
});

export type FeishuUrgentParams = Static<typeof FeishuUrgentSchema>;
