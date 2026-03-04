---
name: feishu-task
description: |
  Feishu task management (Task v2). Activate when user asks to create, view, update, complete, delete tasks, assign people, or comment on tasks.
---

# Feishu Task Tool

Single tool `feishu_task` with action parameter for task operations.

## Actions

### Create Task

```json
{ "action": "create", "summary": "Review Q1 report" }
```

Optional parameters:

- `description`: Task description (max 65536 chars)
- `due`: Due time as Unix timestamp in ms string, e.g. `"1675742789470"`
- `members`: Array of `{ "id": "ou_xxx", "role": "assignee" }` (role: `assignee` or `follower`)
- `user_id_type`: `"open_id"`, `"user_id"`, or `"union_id"` (default: `open_id`)

Full example:

```json
{
  "action": "create",
  "summary": "Review Q1 report",
  "description": "Check revenue and expenses",
  "due": "1675742789470",
  "members": [{ "id": "ou_abc", "role": "assignee" }]
}
```

Returns `task_id`, `summary`, `description`, `due`.

### Get Task

```json
{ "action": "get", "task_id": "d300ad12-xxxx" }
```

Returns full task details including summary, description, due, members, status.

### List Tasks

> **Requires OAuth**: The list action requires `user_access_token`. If no user token is available, the tool returns `auth_url` — present it as a clickable link. **The command name is `/feishu-auth` (with hyphen). NEVER write `/feishu auth` (with space).**

```json
{ "action": "list" }
```

Optional parameters:

- `page_size`: 1-100 (default: 50)
- `page_token`: Pagination token from previous response
- `completed`: `true` to list completed tasks, `false` for incomplete

```json
{ "action": "list", "page_size": 10, "completed": false }
```

Returns `items`, `has_more`, `page_token`.

### Update Task

```json
{ "action": "update", "task_id": "d300ad12-xxxx", "summary": "New title" }
```

Updatable fields: `summary`, `description`, `due`. Pass only the fields you want to change. Set `due` to empty string to clear it.

### Complete Task

```json
{ "action": "complete", "task_id": "d300ad12-xxxx" }
```

Marks the task as completed.

### Delete Task

```json
{ "action": "delete", "task_id": "d300ad12-xxxx" }
```

Permanently deletes the task.

### Add Members

```json
{
  "action": "add_members",
  "task_id": "d300ad12-xxxx",
  "members": [{ "id": "ou_abc", "role": "assignee" }]
}
```

Adds assignees or followers to an existing task. Requires `members` array.

### Add Comment

```json
{
  "action": "add_comment",
  "task_id": "d300ad12-xxxx",
  "comment": "Updated the timeline, please review."
}
```

Posts a text comment on the task.

## Pagination

When `has_more` is `true` in a list response, pass the returned `page_token` to fetch the next page:

```json
{ "action": "list", "page_token": "returned_token" }
```

## Permissions

Requires Feishu app permission: "查看、创建、编辑和删除飞书任务"

## User Authorization (OAuth)

The `list` action requires `user_access_token`.

When the user has not authorized (or the token has expired), the tool automatically returns:

- An `error` field (`NOT_AUTHORIZED` or `TOKEN_EXPIRED`)
- A `message` field with a ready-to-click authorization link
- An `auth_url` field containing the raw URL

**IMPORTANT**: When the tool returns `auth_url`, present it directly to the user as a clickable link. Do NOT modify, fabricate, or guess authorization URLs. Just forward the link from the tool response.

If the tool cannot generate a link (missing appId), tell the user to type `/feishu-auth` in the chat.

After authorization:

- Token is persisted and auto-refreshed (valid ~30 days)
- Re-run `/feishu-auth force` to re-authorize if the refresh token expires

## Multi-user Support

Each user in a Feishu group must authorize independently:

- User A runs `/feishu-auth` → authorizes with their Feishu account
- User B runs `/feishu-auth` → authorizes with their Feishu account
- When User A asks the bot to list tasks, the bot uses A's token (sees only A's tasks)
- When User B asks the bot to list tasks, the bot uses B's token (sees only B's tasks)

Tokens are stored per user and automatically refreshed for ~30 days.

## Configuration

Enable in `channels.feishu.tools`:

```json
{ "tools": { "task": true } }
```

Disabled by default; must be explicitly enabled.

For OAuth callback, optionally set `channels.feishu.oauthCallbackUrl`:

```json
{ "oauthCallbackUrl": "http://localhost:18789/plugins/feishu/oauth/callback" }
```

The callback URL must match the redirect URL configured in the Feishu Open Platform app settings.
