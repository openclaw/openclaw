import { Type, type Static } from "typebox";

const AccountId = Type.Optional(
  Type.String({ description: "Optional Feishu account ID for multi-account configurations" }),
);

const UnixSecondsString = Type.String({
  pattern: "^[0-9]+$",
  description: 'Unix timestamp in seconds, encoded as a decimal string, for example "1609296809"',
});

const SortType = Type.Union([Type.Literal("ByCreateTimeAsc"), Type.Literal("ByCreateTimeDesc")], {
  description: "Message list sort order. Defaults to ByCreateTimeDesc.",
});

const UserIdType = Type.Union(
  [Type.Literal("open_id"), Type.Literal("user_id"), Type.Literal("union_id")],
  {
    description: "Feishu user ID type for read receipt results. Defaults to open_id.",
  },
);

export const FeishuMessageSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    chat_id: Type.String({ description: "Feishu chat ID to list messages from" }),
    start_time: Type.Optional(UnixSecondsString),
    end_time: Type.Optional(UnixSecondsString),
    page_size: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Page size from 1 to 50. Defaults to 20.",
      }),
    ),
    page_token: Type.Optional(Type.String({ description: "Pagination token" })),
    sort_type: Type.Optional(SortType),
    accountId: AccountId,
  }),
  Type.Object({
    action: Type.Literal("delete"),
    message_id: Type.String({ description: "Message ID to delete" }),
    chat_id: Type.Optional(Type.String({ description: "Optional Feishu chat ID" })),
    accountId: AccountId,
  }),
  Type.Object({
    action: Type.Literal("recall"),
    message_id: Type.String({ description: "Message ID to recall" }),
    chat_id: Type.Optional(Type.String({ description: "Optional Feishu chat ID" })),
    accountId: AccountId,
  }),
  Type.Object({
    action: Type.Union([Type.Literal("read_receipts"), Type.Literal("read_users")], {
      description: "Query users who have read a bot-sent Feishu message.",
    }),
    message_id: Type.String({ description: "Message ID to query read receipts for" }),
    user_id_type: Type.Optional(UserIdType),
    page_size: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Page size from 1 to 50. Defaults to 20.",
      }),
    ),
    page_token: Type.Optional(Type.String({ description: "Pagination token" })),
    accountId: AccountId,
  }),
]);

export type FeishuMessageParams = Static<typeof FeishuMessageSchema>;
