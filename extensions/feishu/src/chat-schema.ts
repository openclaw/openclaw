import { Type, type Static } from "@sinclair/typebox";

export const FeishuChatSchema = Type.Union([
  Type.Object({
    action: Type.Literal("members"),
    chat_id: Type.String({ description: "Chat ID (from URL or event payload)" }),
    page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
    page_token: Type.Optional(Type.String({ description: "Pagination token" })),
    member_id_type: Type.Optional(
      Type.Union([Type.Literal("open_id"), Type.Literal("user_id"), Type.Literal("union_id")], {
        description: "Member ID type (default: open_id)",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("info"),
    chat_id: Type.String({ description: "Chat ID (from URL or event payload)" }),
  }),
]);

export type FeishuChatParams = Static<typeof FeishuChatSchema>;
