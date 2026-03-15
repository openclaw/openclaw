import { Type, type Static } from "@sinclair/typebox";

const CHAT_ACTION_VALUES = ["members", "info", "list"] as const;
const MEMBER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;
const SORT_TYPE_VALUES = ["ByCreateTimeAsc", "ByActiveTimeDesc"] as const;

export const FeishuChatSchema = Type.Object({
  action: Type.Unsafe<(typeof CHAT_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...CHAT_ACTION_VALUES],
    description: "Action to run: members | info | list",
  }),
  chat_id: Type.Optional(
    Type.String({ description: "Chat ID (required for members/info, not needed for list)" }),
  ),
  accountId: Type.Optional(
    Type.String({
      description: "Feishu account ID to use (defaults to the calling agent's bound account)",
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  member_id_type: Type.Optional(
    Type.Unsafe<(typeof MEMBER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...MEMBER_ID_TYPE_VALUES],
      description: "Member ID type (default: open_id)",
    }),
  ),
  sort_type: Type.Optional(
    Type.Unsafe<(typeof SORT_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...SORT_TYPE_VALUES],
      description: "Sort order for list action (default: ByCreateTimeAsc)",
    }),
  ),
  user_id_type: Type.Optional(
    Type.Unsafe<(typeof MEMBER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...MEMBER_ID_TYPE_VALUES],
      description: "User ID type for list action (default: open_id)",
    }),
  ),
});

export type FeishuChatParams = Static<typeof FeishuChatSchema>;
