import { Type, type Static } from "@sinclair/typebox";

export const FeishuReactionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("add"),
    message_id: Type.String({ description: "Message ID to add reaction to" }),
    emoji_type: Type.String({
      description:
        'Feishu emoji type, e.g. "THUMBSUP", "HEART", "SMILE", "LAUGH", "CLAP", "FIRE", "PARTY", "CHECK"',
    }),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    message_id: Type.String({ description: "Message ID to remove reaction from" }),
    reaction_id: Type.String({ description: "Reaction ID to remove (from list action)" }),
  }),
  Type.Object({
    action: Type.Literal("list"),
    message_id: Type.String({ description: "Message ID to list reactions for" }),
    emoji_type: Type.Optional(Type.String({ description: "Filter by emoji type (optional)" })),
  }),
]);

export type FeishuReactionParams = Static<typeof FeishuReactionSchema>;
