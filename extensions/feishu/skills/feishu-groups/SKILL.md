---
name: feishu-groups
description: |
  List or search Feishu groups the bot is in. Activate when user mentions groups, group chats, or needs to send messages to a group.
---

# Feishu Groups Tool

Tool `feishu_groups` lists and searches groups/chats the bot is a member of. Auto-syncs from API when cache is empty.

## Actions

### List All Groups

```json
{ "action": "list" }
```

Returns all groups the bot is in: `chat_id`, `name`, `description`, `member_count`.

### Search Groups by Name

```json
{ "action": "search", "keyword": "项目" }
```

Fuzzy search by group name. If no match found after sync, returns a list of all groups the bot is in and prompts user to add the bot to the target group.

## Workflow: Send to Group

1. `feishu_groups` → search for the target group by name
2. Get `chat_id` from results
3. `feishu_send` → send message with `receive_id_type: "chat_id"`

## Permissions

Required: `im:chat:readonly` — Read chat/group info
