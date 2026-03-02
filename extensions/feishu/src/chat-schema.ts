import { Type, type Static } from "@sinclair/typebox";

const CHAT_ACTION_VALUES = ["members", "info", "search"] as const;
const MEMBER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;

export const FeishuChatSchema = Type.Object({
  action: Type.Unsafe<(typeof CHAT_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...CHAT_ACTION_VALUES],
    description: "Action: members | info | search (find chats by name)",
  }),
  chat_id: Type.Optional(Type.String({ description: "Chat ID (required for members/info)" })),
  query: Type.Optional(Type.String({ description: "Search keyword (required for search)" })),
  page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  member_id_type: Type.Optional(
    Type.Unsafe<(typeof MEMBER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...MEMBER_ID_TYPE_VALUES],
      description: "Member ID type (default: open_id)",
    }),
  ),
});

export type FeishuChatParams = Static<typeof FeishuChatSchema>;
