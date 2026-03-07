---
name: feishu-send
description: |
  Send messages to Feishu users or groups. Activate when user asks to send a message, notify someone, forward content, or send files via Feishu.
---

# Feishu Send Tool

Tool `feishu_send` sends messages to users or groups. Supports text, file upload, and @all mentions.

**Important:** You must resolve the recipient's ID first:
- **Person** → Use `feishu_contacts` to search by name and get `open_id`
- **Group** → Use `feishu_groups` to search by name and get `chat_id`

## Actions

### Send Text Message

```json
{
  "action": "text",
  "receive_id": "ou_xxx",
  "receive_id_type": "open_id",
  "text": "Hello, this is a message from the bot"
}
```

- `receive_id_type`: `"open_id"` for users, `"chat_id"` for groups

### Send File

```json
{
  "action": "file",
  "receive_id": "ou_xxx",
  "receive_id_type": "open_id",
  "file_path": "/path/to/document.pdf"
}
```

Uploads the local file via API then sends it as a file message.

### Send @All in Group

```json
{
  "action": "mention_all",
  "receive_id": "oc_xxx",
  "receive_id_type": "chat_id",
  "text": "Important announcement for everyone"
}
```

Only works in group chats (`chat_id`).

## Complete Workflow Example

User says: "给梅晓华发信息：明天10点开会"

```
Step 1: feishu_contacts → { "action": "search", "keyword": "梅晓华" }
        → { "results": [{ "open_id": "ou_abc123", "name": "梅晓华" }] }

Step 2: feishu_send → { "action": "text", "receive_id": "ou_abc123",
                        "receive_id_type": "open_id", "text": "明天10点开会" }
        → { "messageId": "om_xxx" }
```

## Safety Rules

1. Confirm recipient and content before sending
2. Non-urgent messages between 23:00–08:00 require double confirmation
3. For file sending, verify the file path exists

## Permissions

| Scope | Description |
|---|---|
| `im:message:send_as_bot` | Send messages as bot |
| `im:resource` | Upload/download message resources |
