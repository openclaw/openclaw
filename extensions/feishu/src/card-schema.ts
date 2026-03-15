import { Type, type Static } from "@sinclair/typebox";

const CARD_ACTION_VALUES = ["send", "update"] as const;

export const FeishuCardToolSchema = Type.Object({
  action: Type.Unsafe<(typeof CARD_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...CARD_ACTION_VALUES],
    description: "Action to run: send | update",
  }),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID to send the card to (required for send)",
    }),
  ),
  message_id: Type.Optional(
    Type.String({
      description: "Message ID of the card to update (required for update)",
    }),
  ),
  card: Type.Unsafe<Record<string, unknown>>({
    type: "object",
    description:
      "Card JSON payload (Feishu interactive card schema 2.0). " +
      "Must include a valid card structure with header and/or elements.",
  }),
  reply_to_message_id: Type.Optional(
    Type.String({
      description: "Message ID to reply to (optional, for send only)",
    }),
  ),
  reply_in_thread: Type.Optional(
    Type.Boolean({
      description: "Whether to reply in a topic thread (optional, for send only)",
    }),
  ),
});

export type FeishuCardToolParams = Static<typeof FeishuCardToolSchema>;
