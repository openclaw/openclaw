---
name: feishu-task
description: |
  Feishu Task, tasklist, subtask, comment, and attachment management. Activate when user mentions tasks, tasklists, subtasks, task comments, task attachments, or task links.
---

# Feishu Task Tools

Tools:

- `feishu_task_create`
- `feishu_task_subtask_create`
- `feishu_task_get`
- `feishu_task_update`
- `feishu_task_delete`
- `feishu_task_comment_create`
- `feishu_task_comment_list`
- `feishu_task_comment_get`
- `feishu_task_comment_update`
- `feishu_task_comment_delete`
- `feishu_task_attachment_upload`
- `feishu_task_attachment_list`
- `feishu_task_attachment_get`
- `feishu_task_attachment_delete`
- `feishu_task_add_tasklist`
- `feishu_task_remove_tasklist`
- `feishu_tasklist_create`
- `feishu_tasklist_get`
- `feishu_tasklist_get_tasks`
- `feishu_tasklist_list`
- `feishu_tasklist_update`
- `feishu_tasklist_delete`
- `feishu_tasklist_add_members`
- `feishu_tasklist_remove_members`

## Notes

- `task_guid` can be taken from a task URL (guid query param) or from `feishu_task_get` output.
- If you only have a `tasklist_guid`, use `feishu_tasklist_get_tasks` to enumerate tasks and discover each `task_guid`.
- `comment_id` can be obtained from `feishu_task_comment_list` output.
- `attachment_guid` can be obtained from `feishu_task_attachment_list` output.
- `user_id_type` controls returned/accepted user identity type (`open_id`, `user_id`, `union_id`).
- If no assignee is specified, set the assignee to the requesting user. Avoid creating unassigned tasks because the user may not be able to view them.
- Task visibility: users can only view tasks when they are included as assignee.
- Current limitation: the bot can only create subtasks for tasks created by itself.
- Attachment upload supports local `file_path` and remote `file_url`. Remote URLs are fetched with runtime media safety checks and size limit (`mediaMaxMb`).
- Keep tasklist owner as the bot. Add users as members to avoid losing bot access.
- Use tasklist tools for tasklist membership changes; do not use `feishu_task_update` to move tasks between tasklists.

## Create Task

```json
{
  "summary": "Quarterly review",
  "description": "Prepare review notes",
  "due": { "timestamp": "1735689600000", "is_all_day": true },
  "members": [{ "id": "ou_xxx", "role": "assignee", "type": "user" }],
  "user_id_type": "open_id"
}
```

## Create Subtask

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "summary": "Draft report outline",
  "description": "Collect key metrics",
  "due": { "timestamp": "1735689600000", "is_all_day": true },
  "members": [{ "id": "ou_xxx", "role": "assignee", "type": "user" }],
  "user_id_type": "open_id"
}
```

## Create Comment

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "content": "Looks good to me",
  "user_id_type": "open_id"
}
```

## Upload Attachment (file_path)

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "file_path": "/path/to/report.pdf",
  "user_id_type": "open_id"
}
```

## Upload Attachment (file_url)

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "file_url": "https://oss-example.com/bucket/report.pdf",
  "filename": "report.pdf",
  "user_id_type": "open_id"
}
```

## Tasklist Membership For Tasks

### Add Task to Tasklist

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "section_guid": "6d0f9f48-2e06-4e3d-8a0f-acde196e8c61",
  "user_id_type": "open_id"
}
```

### Remove Task from Tasklist

```json
{
  "task_guid": "e297ddff-06ca-4166-b917-4ce57cd3a7a0",
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "user_id_type": "open_id"
}
```

## Tasklists

Tasklists support three roles: owner (read/edit/manage), editor (read/edit), viewer (read).

### Create Tasklist

```json
{
  "name": "Project Alpha Tasklist",
  "members": [{ "id": "ou_xxx", "type": "user", "role": "editor" }],
  "user_id_type": "open_id"
}
```

### Get Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "user_id_type": "open_id"
}
```

### List Tasklists

```json
{
  "page_size": 50,
  "page_token": "aWQ9NzEwMjMzMjMxMDE=",
  "user_id_type": "open_id"
}
```

### Get Tasks of Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "page_size": 100,
  "completed": false,
  "user_id_type": "open_id"
}
```

### Update Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "tasklist": {
    "name": "Renamed Tasklist",
    "owner": { "id": "ou_xxx", "type": "user", "role": "owner" }
  },
  "update_fields": ["name", "owner"],
  "origin_owner_to_role": "editor",
  "user_id_type": "open_id"
}
```

### Delete Tasklist

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004"
}
```

### Add Tasklist Members

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "members": [{ "id": "ou_xxx", "type": "user", "role": "editor" }],
  "user_id_type": "open_id"
}
```

### Remove Tasklist Members

```json
{
  "tasklist_guid": "cc371766-6584-cf50-a222-c22cd9055004",
  "members": [{ "id": "ou_xxx", "type": "user", "role": "viewer" }],
  "user_id_type": "open_id"
}
```
