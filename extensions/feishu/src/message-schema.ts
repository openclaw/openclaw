import { Type, type Static } from "@sinclair/typebox";

const MESSAGE_ACTION_VALUES = ["list", "get"] as const;
const SORT_TYPE_VALUES = ["ByCreateTimeAsc", "ByCreateTimeDesc"] as const;
const CONTAINER_ID_TYPE_VALUES = ["chat", "thread"] as const;

export const FeishuMessageSchema = Type.Object({
  action: Type.Unsafe<(typeof MESSAGE_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...MESSAGE_ACTION_VALUES],
    description: "Action: list (chat history or thread messages) | get (single message)",
  }),
  chat_id: Type.Optional(
    Type.String({
      description:
        'Chat ID, e.g. "oc_xxx". Required for list when container_id_type is "chat" (default).',
    }),
  ),
  thread_id: Type.Optional(
    Type.String({
      description:
        'Thread ID, e.g. "omt_xxx". Required for list when container_id_type is "thread". ' +
        "Use this to fetch all replies within a specific topic/thread.",
    }),
  ),
  container_id_type: Type.Optional(
    Type.Unsafe<(typeof CONTAINER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...CONTAINER_ID_TYPE_VALUES],
      description:
        'Container type: "chat" (default, group/p2p messages) or "thread" (topic replies). ' +
        "When chat, only the root message of a thread is returned. " +
        "Use thread + thread_id to get all replies in a topic.",
    }),
  ),
  message_id: Type.Optional(Type.String({ description: "Message ID (required for get)" })),
  start_time: Type.Optional(
    Type.String({
      description:
        'Start time as a DATE STRING. MUST use format YYYY-MM-DD (e.g. "2026-03-01") ' +
        'or ISO 8601 with timezone (e.g. "2026-03-01T09:00:00+08:00"). ' +
        "DO NOT compute Unix timestamps — the tool converts dates automatically. " +
        "Bare date resolves to start of day 00:00:00 in Asia/Shanghai (CST, UTC+8). " +
        'For list with container_id_type="chat" only. Thread type does NOT support time range.',
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        'End time as a DATE STRING. MUST use format YYYY-MM-DD (e.g. "2026-03-01") ' +
        'or ISO 8601 with timezone (e.g. "2026-03-01T23:59:59+08:00"). ' +
        "DO NOT compute Unix timestamps — the tool converts dates automatically. " +
        "Bare date resolves to end of day 23:59:59 in Asia/Shanghai (CST, UTC+8). " +
        'For list with container_id_type="chat" only. Thread type does NOT support time range.',
    }),
  ),
  sort_type: Type.Optional(
    Type.Unsafe<(typeof SORT_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...SORT_TYPE_VALUES],
      description: "Sort order (default: ByCreateTimeDesc)",
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Page size (1-50, default 20)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  expand_threads: Type.Optional(
    Type.Boolean({
      description:
        "Auto-expand thread/topic replies when listing chat messages (default: true). " +
        "When enabled, messages with thread_id will include a thread_replies array. " +
        "Set to false to skip thread expansion for faster results.",
    }),
  ),
});

export type FeishuMessageParams = Static<typeof FeishuMessageSchema>;
