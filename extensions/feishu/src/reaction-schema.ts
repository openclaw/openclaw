import { Type, type Static } from "@sinclair/typebox";

const REACTION_ACTION_VALUES = ["add", "remove", "list"] as const;

export const FeishuReactionSchema = Type.Object({
  action: Type.Unsafe<(typeof REACTION_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...REACTION_ACTION_VALUES],
    description: "Action to run: add | remove | list",
  }),
  message_id: Type.String({ description: "Message ID to react to" }),
  emoji_type: Type.Optional(
    Type.String({
      description:
        'Feishu emoji type (required for add/remove). Examples: THUMBSUP, HEART, SMILE, FIRE, CLAP, OK, PRAY',
    }),
  ),
  reaction_id: Type.Optional(
    Type.String({
      description: "Reaction ID (required for remove action, returned by add/list)",
    }),
  ),
  account_id: Type.Optional(Type.String({ description: "Feishu account ID (optional)" })),
});

export type FeishuReactionParams = Static<typeof FeishuReactionSchema>;
