---
name: feishu-chat
description: |
  Feishu group chat operations: query members/info, read/write group announcements, and manage group lifecycle. Activate when user mentions Feishu group chats, group announcements, or needs to create/manage groups.
---

# Feishu Chat Tool

Single tool `feishu_chat` with `action` parameter for all chat operations.

## Query Actions

### Get Chat Info

```json
{ "action": "info", "chat_id": "oc_xxx" }
```

Returns: name, description, owner_id, user_count, chat_mode, avatar, and other metadata.

### List Members

```json
{ "action": "members", "chat_id": "oc_xxx" }
```

With pagination:

```json
{
  "action": "members",
  "chat_id": "oc_xxx",
  "page_size": 50,
  "page_token": "...",
  "member_id_type": "open_id"
}
```

Returns: member list with `member_id`, `name`, `tenant_key`. Use `page_token` from response to paginate.

## Announcement Actions

### Read Announcement

```json
{ "action": "get_announcement", "chat_id": "oc_xxx" }
```

Returns: `announcement_type` (`doc` or `docx`), content/blocks summary. Check `hint` field — if present, structured blocks (images, tables) exist that require `list_announcement_blocks`.

### List All Blocks

```json
{ "action": "list_announcement_blocks", "chat_id": "oc_xxx" }
```

Returns full block list. Use to inspect a `docx` announcement's structure before editing.

### Get Single Block

```json
{ "action": "get_announcement_block", "chat_id": "oc_xxx", "block_id": "blk_xxx" }
```

### Write Announcement (replace/append)

```json
{ "action": "write_announcement", "chat_id": "oc_xxx", "content": "New content" }
```

- For `doc` announcements: replaces the entire content.
- For `docx` announcements: appends a new text block under the page root (full replace is not supported by the API).

### Append to Announcement

```json
{ "action": "append_announcement", "chat_id": "oc_xxx", "content": "Additional text" }
```

- For `doc`: concatenates to existing content.
- For `docx`: appends a new text block.

### Update a Specific Block

```json
{
  "action": "update_announcement_block",
  "chat_id": "oc_xxx",
  "block_id": "blk_xxx",
  "content": "Updated text"
}
```

Patches a specific block's text elements. Use `list_announcement_blocks` first to find the `block_id`.

## Group Management Actions

### Create Group Chat

```json
{ "action": "create_chat", "name": "Project Team", "user_ids": ["ou_xxx", "ou_yyy"] }
```

With description:

```json
{
  "action": "create_chat",
  "name": "Project Team",
  "description": "Q2 planning group",
  "user_ids": ["ou_xxx"]
}
```

Returns: `chat_id` and group metadata.

### Add Members

```json
{ "action": "add_members", "chat_id": "oc_xxx", "user_ids": ["ou_zzz"] }
```

### Check Bot Membership

```json
{ "action": "check_bot_in_chat", "chat_id": "oc_xxx" }
```

Returns: `in_chat: true/false`. Does not throw on 90003 (bot not in chat) — returns `in_chat: false` instead.

### Delete / Disband Chat

```json
{ "action": "delete_chat", "chat_id": "oc_xxx" }
```

### Create Session Chat (one-step)

Creates a group chat and sends a greeting message in a single call:

```json
{
  "action": "create_session_chat",
  "name": "Q2 Kickoff",
  "user_ids": ["ou_xxx", "ou_yyy"],
  "greeting": "Hi team! I've created this group for our Q2 planning."
}
```

Omit `greeting` to use the default message. Even if the greeting fails to send, the chat is still returned with `chat_id`.

## Configuration

```yaml
channels:
  feishu:
    tools:
      chat: true # default: false
```

## Permissions

Required: `im:chat`, `im:chat:readonly`, `im:message:send_as_bot`, `docx:document`
