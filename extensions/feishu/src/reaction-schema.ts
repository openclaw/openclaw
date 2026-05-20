import { Type, type Static } from "typebox";

const AccountId = Type.Optional(
  Type.String({ description: "Optional Feishu account ID for multi-account configurations" }),
);

export const FeishuReactionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("add"),
    message_id: Type.String({ description: "Message ID to add the reaction to" }),
    emoji_type: Type.String({
      description:
        'Feishu emoji type or common alias, for example "THUMBSUP", "HEART", "SMILE", "CLAP", "OK", "👍", or "heart"',
    }),
    accountId: AccountId,
  }),
  Type.Object({
    action: Type.Literal("remove"),
    message_id: Type.String({ description: "Message ID to remove the reaction from" }),
    reaction_id: Type.Optional(
      Type.String({ description: "Reaction ID returned by the list action" }),
    ),
    emoji_type: Type.Optional(
      Type.String({
        description:
          "Emoji type to remove from the bot's own reactions when reaction_id is omitted",
      }),
    ),
    accountId: AccountId,
  }),
  Type.Object({
    action: Type.Literal("list"),
    message_id: Type.String({ description: "Message ID to list reactions for" }),
    emoji_type: Type.Optional(Type.String({ description: "Optional emoji type filter" })),
    accountId: AccountId,
  }),
]);

export type FeishuReactionParams = Static<typeof FeishuReactionSchema>;
