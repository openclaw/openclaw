# Motion Routing Reference

**App name:** `motion`
**Base URL proxied:** `api.usemotion.com`

## API Path Pattern

```
/motion/v1/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /motion/v1/users/me
```

### List Workspaces

```bash
GET /motion/v1/workspaces
```

### List Tasks

```bash
GET /motion/v1/tasks
GET /motion/v1/tasks?workspaceId={workspaceId}
GET /motion/v1/tasks?projectId={projectId}
```

### Get Task

```bash
GET /motion/v1/tasks/{taskId}
```

### Create Task

```bash
POST /motion/v1/tasks
Content-Type: application/json

{
  "name": "Task name",
  "workspaceId": "ws_xxx",
  "priority": "HIGH",
  "duration": 30
}
```

### Update Task

```bash
PATCH /motion/v1/tasks/{taskId}
Content-Type: application/json

{
  "name": "Updated name",
  "priority": "LOW"
}
```

### Delete Task

```bash
DELETE /motion/v1/tasks/{taskId}
```

### Move Task

```bash
POST /motion/v1/tasks/{taskId}/move
Content-Type: application/json

{
  "workspaceId": "ws_new"
}
```

### Unassign Task

```bash
POST /motion/v1/tasks/{taskId}/unassign
```

### List Projects

```bash
GET /motion/v1/projects?workspaceId={workspaceId}
```

### Get Project

```bash
GET /motion/v1/projects/{projectId}
```

### Create Project

```bash
POST /motion/v1/projects
Content-Type: application/json

{
  "name": "Project name",
  "workspaceId": "ws_xxx",
  "priority": "HIGH"
}
```

### List Users

```bash
GET /motion/v1/users?workspaceId={workspaceId}
```

### List Comments

```bash
GET /motion/v1/comments?taskId={taskId}
```

### Create Comment

```bash
POST /motion/v1/comments
Content-Type: application/json

{
  "taskId": "tk_xxx",
  "content": "Comment text"
}
```

### List Recurring Tasks

```bash
GET /motion/v1/recurring-tasks?workspaceId={workspaceId}
```

### Create Recurring Task

```bash
POST /motion/v1/recurring-tasks
Content-Type: application/json

{
  "name": "Weekly review",
  "workspaceId": "ws_xxx",
  "frequency": "weekly"
}
```

### Delete Recurring Task

```bash
DELETE /motion/v1/recurring-tasks/{recurringTaskId}
```

### List Schedules

```bash
GET /motion/v1/schedules
```

### List Statuses

```bash
GET /motion/v1/statuses?workspaceId={workspaceId}
```

## Notes

- Workspace IDs start with `ws_`
- Task IDs start with `tk_`
- Project IDs start with `pr_`
- Timestamps are in ISO 8601 format
- Priority values: ASAP, HIGH, MEDIUM, LOW
- Deadline types: HARD, SOFT, NONE
- Cursor-based pagination with `cursor` query parameter
- `workspaceId` is required for listing projects, users, recurring tasks, and statuses

## Resources

- [Motion API Documentation](https://docs.usemotion.com/)
- [Motion API Reference](https://docs.usemotion.com/api-reference)
- [Motion Cookbooks](https://docs.usemotion.com/cookbooks/getting-started)
