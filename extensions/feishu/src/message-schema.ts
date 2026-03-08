import { Type, type Static } from "@sinclair/typebox";

const MESSAGE_ACTION_VALUES = ["list", "get"] as const;
const SORT_TYPE_VALUES = ["ByCreateTimeAsc", "ByCreateTimeDesc"] as const;

export const FeishuMessageSchema = Type.Object({
  action: Type.Unsafe<(typeof MESSAGE_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...MESSAGE_ACTION_VALUES],
    description: "Action: list (chat history) | get (single message)",
  }),
  chat_id: Type.Optional(Type.String({ description: "Chat ID (required for list)" })),
  message_id: Type.Optional(Type.String({ description: "Message ID (required for get)" })),
  start_time: Type.Optional(Type.String({ description: "Start timestamp in seconds (for list)" })),
  end_time: Type.Optional(Type.String({ description: "End timestamp in seconds (for list)" })),
  sort_type: Type.Optional(
    Type.Unsafe<(typeof SORT_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...SORT_TYPE_VALUES],
      description: "Sort order (default: ByCreateTimeDesc)",
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Page size (1-50, default 20)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
});

export type FeishuMessageParams = Static<typeof FeishuMessageSchema>;
