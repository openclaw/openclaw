import { Type, type Static } from "@sinclair/typebox";

const CHAT_ACTION_VALUES = [
  "members",
  "info",
  "get_announcement",
  "list_announcement_blocks",
  "get_announcement_block",
  "write_announcement",
  "append_announcement",
  "update_announcement_block",
  "create_chat",
  "add_members",
  "check_bot_in_chat",
  "delete_chat",
  "create_session_chat",
] as const;

const MEMBER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;

export const FeishuChatSchema = Type.Object({
  action: Type.Unsafe<(typeof CHAT_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...CHAT_ACTION_VALUES],
    description:
      "Action to run. Chat queries: members | info. Announcements: get_announcement | list_announcement_blocks | get_announcement_block | write_announcement | append_announcement | update_announcement_block. Group management: create_chat | add_members | check_bot_in_chat | delete_chat | create_session_chat",
  }),
  // ── fields used by chat query actions ────────────────────────────────────
  chat_id: Type.Optional(
    Type.String({
      description:
        "Chat ID (from URL or event payload). Required for: members, info, get_announcement, list_announcement_blocks, get_announcement_block, write_announcement, append_announcement, update_announcement_block, add_members, check_bot_in_chat, delete_chat",
    }),
  ),
  page_size: Type.Optional(
    Type.Number({ description: "Page size (1-100, default 50). Used by: members" }),
  ),
  page_token: Type.Optional(Type.String({ description: "Pagination token. Used by: members" })),
  member_id_type: Type.Optional(
    Type.Unsafe<(typeof MEMBER_ID_TYPE_VALUES)[number]>({
      type: "string",
      enum: [...MEMBER_ID_TYPE_VALUES],
      description: "Member ID type (default: open_id). Used by: members",
    }),
  ),
  // ── fields used by announcement actions ──────────────────────────────────
  block_id: Type.Optional(
    Type.String({
      description:
        "Block ID from list_announcement_blocks. Required for: get_announcement_block, update_announcement_block",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Text content. Required for: write_announcement, append_announcement, update_announcement_block",
    }),
  ),
  // ── fields used by group management actions ───────────────────────────────
  name: Type.Optional(
    Type.String({
      description: "Group chat name. Required for: create_chat, create_session_chat",
    }),
  ),
  user_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "List of user open_ids. Required for: add_members, create_session_chat. Optional for: create_chat",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Group chat description. Optional for: create_chat, create_session_chat",
    }),
  ),
  greeting: Type.Optional(
    Type.String({
      description:
        "Greeting message sent on creation. Optional for: create_session_chat (default: Hello! I've created this group chat for us to collaborate.)",
    }),
  ),
});

export type FeishuChatParams = Static<typeof FeishuChatSchema>;
