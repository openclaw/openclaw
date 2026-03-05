import { Type, type Static } from "@sinclair/typebox";

const CHAT_ACTION_VALUES = ["members", "info", "history"] as const;
const MEMBER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;
const SORT_TYPE_VALUES = ["ByCreateTimeAsc", "ByCreateTimeDesc"] as const;

export const FeishuChatSchema = Type.Object({
  action: Type.Unsafe<(typeof CHAT_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...CHAT_ACTION_VALUES],
    description: "Action to run: members | info | history",
  }),
  chat_id: Type.String({ description: "Chat ID (from URL or event payload)" }),
  page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  member_id_type: Type.Optional(
    Type.Unsafe<(typeof MEMBER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...MEMBER_ID_TYPE_VALUES],
      description: "Member ID type (default: open_id)",
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description: "Start timestamp in seconds (inclusive). Omit for no lower bound.",
    }),
  ),
  end_time: Type.Optional(
    Type.String({ description: "End timestamp in seconds (inclusive). Omit for no upper bound." }),
  ),
  sort_type: Type.Optional(
    Type.Unsafe<(typeof SORT_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...SORT_TYPE_VALUES],
      description: "Sort order: ByCreateTimeAsc | ByCreateTimeDesc (default: ByCreateTimeDesc)",
    }),
  ),
});

export type FeishuChatParams = Static<typeof FeishuChatSchema>;
