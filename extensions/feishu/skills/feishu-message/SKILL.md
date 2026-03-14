---
name: feishu-message
description: |
  Feishu message history and retrieval. Activate when user asks about chat history, past messages, or specific message lookup.
---

# Feishu Message Tool

Single tool `feishu_message` with action parameter for message operations.

## Actions

### List Messages (Chat History)

```json
{ "action": "list", "chat_id": "oc_xxx" }
```

Returns recent messages from the specified chat. The bot must be a member of the chat.

Optional parameters:

- `start_time`: Start timestamp in seconds (Unix epoch)
- `end_time`: End timestamp in seconds (Unix epoch)
- `sort_type`: `"ByCreateTimeAsc"` or `"ByCreateTimeDesc"` (default: desc)
- `page_size`: 1-50 (default: 20)
- `page_token`: For pagination (from previous response)

Response fields per message:

- `message_id`: Unique message identifier
- `msg_type`: Message type (text, image, file, etc.)
- `body.content`: JSON-encoded message content
- `sender`: Sender info (id, id_type, sender_type)
- `create_time`: Unix timestamp string
- `chat_id`: Chat the message belongs to
- `mentions`: Mentioned users (if any)

### Get Single Message

```json
{ "action": "get", "message_id": "om_xxx" }
```

Returns a single message by its ID.

## Message Content Format

The `body.content` field is JSON-encoded. For text messages:

```json
{ "text": "Hello world" }
```

For rich text, images, files, etc., the structure varies by `msg_type`.

## Pagination

When `has_more` is `true` in the response, pass the returned `page_token` to fetch the next page:

```json
{ "action": "list", "chat_id": "oc_xxx", "page_token": "returned_token" }
```

## Permissions

Requires Feishu app permissions:

- `im:message` or `im:message:readonly` (read messages the bot can access)

The bot can only read messages from chats it has joined.

## Configuration

Enable/disable in `channels.feishu.tools`:

```json
{ "tools": { "message": true } }
```

Enabled by default.
