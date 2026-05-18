import { Type, type Static } from "typebox";

const MESSAGE_ACTION_VALUES = ["list", "delete", "recall", "read_receipts", "read_users"] as const;
const SORT_TYPE_VALUES = ["ByCreateTimeAsc", "ByCreateTimeDesc"] as const;
const USER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;

const AccountId = Type.Optional(
  Type.String({ description: "Optional Feishu account ID for multi-account configurations" }),
);

const UnixSecondsString = Type.String({
  pattern: "^[0-9]+$",
  description: 'Unix timestamp in seconds, encoded as a decimal string, for example "1609296809"',
});

const SortType = Type.Unsafe<(typeof SORT_TYPE_VALUES)[number]>({
  type: "string",
  enum: [...SORT_TYPE_VALUES],
  description: "Message list sort order. Defaults to ByCreateTimeDesc.",
});

const UserIdType = Type.Unsafe<(typeof USER_ID_TYPE_VALUES)[number]>({
  type: "string",
  enum: [...USER_ID_TYPE_VALUES],
  description: "Feishu user ID type for read receipt results. Defaults to open_id.",
});

export const FeishuMessageSchema = Type.Object({
  action: Type.Unsafe<(typeof MESSAGE_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...MESSAGE_ACTION_VALUES],
    description:
      "Action to run: list | delete | recall | read_receipts | read_users. list requires chat_id; delete/recall/read_receipts/read_users require message_id.",
  }),
  chat_id: Type.Optional(
    Type.String({ description: "Feishu chat ID for list, or optional context for delete/recall" }),
  ),
  message_id: Type.Optional(
    Type.String({ description: "Message ID for delete, recall, read_receipts, or read_users" }),
  ),
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
  user_id_type: Type.Optional(UserIdType),
  accountId: AccountId,
});

export type FeishuMessageParams = Static<typeof FeishuMessageSchema>;
