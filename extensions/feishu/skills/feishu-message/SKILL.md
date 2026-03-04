---
name: feishu-message
description: |
  Feishu message history and retrieval. Activate when user asks about chat history, past messages, thread/topic content, or specific message lookup.
---

# Feishu Message Tool

Single tool `feishu_message` with action parameter for message operations.

Uses `tenant_access_token` (app-level). No user OAuth required. The bot must be a member of the target chat.

## Actions

### List Messages (Chat History)

```json
{ "action": "list", "chat_id": "oc_xxx" }
```

Returns recent messages from the specified chat.

**Thread auto-expansion**: By default, when listing chat messages, any message with a `thread_id` (topic root) will automatically include a `thread_replies` array with the first page of replies. This means you get both chat messages and thread content in a single call.

Optional parameters:

- `container_id_type`: `"chat"` (default) or `"thread"`. Normally leave as default — threads are auto-expanded.
- `thread_id`: Thread ID, e.g. `"omt_xxx"`. Only needed when `container_id_type` is `"thread"` (manual thread-only query).
- `start_time`: **MUST pass a date string** like `"2026-03-01"` or ISO 8601 like `"2026-03-01T09:00:00+08:00"`. **NEVER compute or pass Unix timestamps** — the tool converts dates to epoch seconds automatically using Asia/Shanghai (CST, UTC+8). A bare date `"2026-03-01"` resolves to **start of day** (00:00:00 CST). Only works with `container_id_type="chat"`.
- `end_time`: **MUST pass a date string** (same format as `start_time`). A bare date resolves to **end of day** (23:59:59 CST). For "all of March 1", pass `start_time="2026-03-01"` and `end_time="2026-03-01"`. **NEVER pass numeric timestamps.** Only works with `container_id_type="chat"`.
- `sort_type`: `"ByCreateTimeAsc"` or `"ByCreateTimeDesc"` (default: desc)
- `page_size`: 1-50 (default: 20)
- `page_token`: For pagination
- `expand_threads`: Auto-expand threads (default: true). Set `false` to skip for faster results.

### Thread/Topic Handling

When a message has a `thread_id`, it is a topic root. The tool auto-fetches replies (up to 5 threads per page, 20 replies each):

```json
{
  "message_id": "om_root",
  "thread_id": "omt_xxx",
  "body": { "content": "{\"text\":\"topic root message\"}" },
  "thread_replies": [
    { "message_id": "om_reply1", "body": { "content": "{\"text\":\"reply 1\"}" } },
    { "message_id": "om_reply2", "body": { "content": "{\"text\":\"reply 2\"}" } }
  ],
  "thread_has_more": true
}
```

If `thread_has_more` is true, fetch remaining replies manually:

```json
{ "action": "list", "container_id_type": "thread", "thread_id": "omt_xxx" }
```

Note: time range filtering is NOT supported for `container_id_type="thread"`.

### Get Single Message

```json
{ "action": "get", "message_id": "om_xxx" }
```

Returns a single message by its ID.

## Response Fields

Per message:

- `message_id`: Unique message identifier
- `msg_type`: Message type (text, image, file, etc.)
- `body.content`: JSON-encoded message content
- `sender`: Sender info (id, id_type, sender_type)
- `create_time`: Unix timestamp string (milliseconds)
- `chat_id`: Chat the message belongs to
- `mentions`: Mentioned users (if any)
- `thread_id`: Thread ID (only present for thread messages)
- `root_id`: Root message ID in a message tree
- `parent_id`: Parent message ID in a message tree

## Message Content Format

The `body.content` field is JSON-encoded. For text messages:

```json
{ "text": "Hello world" }
```

For rich text, images, files, etc., the structure varies by `msg_type`.

## Pagination

When `has_more` is `true`, pass the returned `page_token` to fetch the next page:

```json
{ "action": "list", "chat_id": "oc_xxx", "page_token": "returned_token" }
```

## Permissions

Requires Feishu app permission: `im:message:readonly` (read single chat and group messages).

For reading **group** messages (not just p2p), the app must also have `im:message.group_msg` enabled.

The bot can only read messages from chats it has joined.

## Common Errors

| Error Code                     | Meaning                      | Action                                                                                              |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `BOT_NOT_IN_CHAT` / `230002`   | Bot not in the target group  | Add the bot to the group                                                                            |
| `PERMISSION_DENIED` / `230027` | Missing permissions          | Enable `im:message:readonly` + `im:message.group_msg` in Feishu Open Platform, publish new version  |
| `230073`                       | Thread invisible to operator | Thread created before bot joined; needs passive subscription (e.g. being @-mentioned in the thread) |

## Configuration

Enable/disable in `channels.feishu.tools`:

```json
{ "tools": { "message": true } }
```

Enabled by default.
