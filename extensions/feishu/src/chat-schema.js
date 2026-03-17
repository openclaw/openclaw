import { Type } from "@sinclair/typebox";
const CHAT_ACTION_VALUES = ["members", "info"];
const MEMBER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"];
const FeishuChatSchema = Type.Object({
  action: Type.Unsafe({
    type: "string",
    enum: [...CHAT_ACTION_VALUES],
    description: "Action to run: members | info"
  }),
  chat_id: Type.String({ description: "Chat ID (from URL or event payload)" }),
  page_size: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  member_id_type: Type.Optional(
    Type.Unsafe({
      type: "string",
      enum: [...MEMBER_ID_TYPE_VALUES],
      description: "Member ID type (default: open_id)"
    })
  )
});
export {
  FeishuChatSchema
};
