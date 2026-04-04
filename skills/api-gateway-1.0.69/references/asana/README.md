# Asana Routing Reference

**App name:** `asana`
**Base URL proxied:** `app.asana.com`

## API Path Pattern

```
/asana/api/1.0/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /asana/api/1.0/users/me
```

### List Workspaces

```bash
GET /asana/api/1.0/workspaces
```

### List Tasks

```bash
GET /asana/api/1.0/tasks?project=PROJECT_GID&opt_fields=name,completed,due_on
```

### Get a Task

```bash
GET /asana/api/1.0/tasks/{task_gid}
```

### Create a Task

```bash
POST /asana/api/1.0/tasks
Content-Type: application/json

{
  "data": {
    "name": "New task",
    "projects": ["PROJECT_GID"],
    "assignee": "USER_GID",
    "due_on": "2025-03-20",
    "notes": "Task description"
  }
}
```

### Update a Task

```bash
PUT /asana/api/1.0/tasks/{task_gid}
Content-Type: application/json

{
  "data": {
    "completed": true
  }
}
```

### Delete a Task

```bash
DELETE /asana/api/1.0/tasks/{task_gid}
```

### Get Subtasks

```bash
GET /asana/api/1.0/tasks/{task_gid}/subtasks
```

### Create Subtask

```bash
POST /asana/api/1.0/tasks/{task_gid}/subtasks
Content-Type: application/json

{
  "data": {
    "name": "Subtask name"
  }
}
```

### List Projects

```bash
GET /asana/api/1.0/projects?workspace=WORKSPACE_GID&opt_fields=name,owner,due_date
```

### Get a Project

```bash
GET /asana/api/1.0/projects/{project_gid}
```

### Create a Project

```bash
POST /asana/api/1.0/projects
Content-Type: application/json

{
  "data": {
    "name": "New Project",
    "workspace": "WORKSPACE_GID"
  }
}
```

### List Users in Workspace

```bash
GET /asana/api/1.0/workspaces/{workspace_gid}/users?opt_fields=name,email
```

### Create Webhook

```bash
POST /asana/api/1.0/webhooks
Content-Type: application/json

{
  "data": {
    "resource": "PROJECT_OR_TASK_GID",
    "target": "https://example.com/webhook",
    "filters": [
      {
        "resource_type": "task",
        "action": "changed",
        "fields": ["completed", "due_on"]
      }
    ]
  }
}
```

### Delete Webhook

```bash
DELETE /asana/api/1.0/webhooks/{webhook_gid}
```

## Notes

- Resource IDs (GIDs) are strings
- Timestamps are in ISO 8601 format
- Use `opt_fields` to specify which fields to return in responses
- Workspaces are the highest-level organizational unit
- Use cursor-based pagination with `offset` parameter
- Webhook creation requires the target URL to respond with 200 status

## Resources

- [Asana API Overview](https://developers.asana.com)
- [API Reference](https://developers.asana.com/reference)
- [Tasks](https://developers.asana.com/reference/tasks)
- [Projects](https://developers.asana.com/reference/projects)
- [Workspaces](https://developers.asana.com/reference/workspaces)
- [Webhooks](https://developers.asana.com/reference/webhooks)
- [LLM Reference](https://developers.asana.com/llms.txt)
