# ClickUp Routing Reference

**App name:** `clickup`
**Base URL proxied:** `api.clickup.com`

## API Path Pattern

```
/clickup/api/v2/{resource}
```

## ClickUp Hierarchy

Workspace (team) → Space → Folder → List → Task

## Common Endpoints

### Get Current User

```bash
GET /clickup/api/v2/user
```

### Get Workspaces (Teams)

```bash
GET /clickup/api/v2/team
```

### Get Spaces

```bash
GET /clickup/api/v2/team/{team_id}/space
```

### Get Folders

```bash
GET /clickup/api/v2/space/{space_id}/folder
```

### Get Lists

```bash
GET /clickup/api/v2/folder/{folder_id}/list
```

### Get Folderless Lists

```bash
GET /clickup/api/v2/space/{space_id}/list
```

### Get Tasks

```bash
GET /clickup/api/v2/list/{list_id}/task?include_closed=true
```

### Get a Task

```bash
GET /clickup/api/v2/task/{task_id}
```

### Create a Task

```bash
POST /clickup/api/v2/list/{list_id}/task
Content-Type: application/json

{
  "name": "Task name",
  "description": "Task description",
  "assignees": [123],
  "status": "to do",
  "priority": 2,
  "due_date": 1709251200000,
  "tags": ["api", "backend"]
}
```

### Update a Task

```bash
PUT /clickup/api/v2/task/{task_id}
Content-Type: application/json

{
  "status": "complete",
  "priority": null
}
```

### Delete a Task

```bash
DELETE /clickup/api/v2/task/{task_id}
```

### Get Filtered Team Tasks

```bash
GET /clickup/api/v2/team/{team_id}/task?statuses[]=to%20do&assignees[]=123
```

### Create Space

```bash
POST /clickup/api/v2/team/{team_id}/space
Content-Type: application/json

{
  "name": "New Space",
  "multiple_assignees": true
}
```

### Create Folder

```bash
POST /clickup/api/v2/space/{space_id}/folder
Content-Type: application/json

{"name": "New Folder"}
```

### Create List

```bash
POST /clickup/api/v2/folder/{folder_id}/list
Content-Type: application/json

{"name": "New List"}
```

### Create Webhook

```bash
POST /clickup/api/v2/team/{team_id}/webhook
Content-Type: application/json

{
  "endpoint": "https://example.com/webhook",
  "events": ["taskCreated", "taskUpdated", "taskDeleted"]
}
```

### Delete Webhook

```bash
DELETE /clickup/api/v2/webhook/{webhook_id}
```

## Notes

- Task IDs are strings, timestamps are Unix milliseconds
- Priority values: 1=urgent, 2=high, 3=normal, 4=low, null=none
- Workspaces are called "teams" in the API
- Status values must match exact status names configured in the list
- Use page-based pagination with `page` parameter (0-indexed)
- Responses are limited to 100 items per page

## Resources

- [ClickUp API Overview](https://developer.clickup.com/docs/Getting%20Started.md)
- [Tasks](https://developer.clickup.com/reference/gettasks.md)
- [Spaces](https://developer.clickup.com/reference/getspaces.md)
- [Lists](https://developer.clickup.com/reference/getlists.md)
- [Webhooks](https://developer.clickup.com/reference/createwebhook.md)
- [Rate Limits](https://developer.clickup.com/docs/rate-limits.md)
- [LLM Reference](https://developer.clickup.com/llms.txt)
