# Google Tasks Routing Reference

**App name:** `google-tasks`
**Base URL proxied:** `tasks.googleapis.com`

## API Path Pattern

```
/google-tasks/tasks/v1/{endpoint}
```

## Common Endpoints

### Task Lists

#### List Task Lists

```bash
GET /google-tasks/tasks/v1/users/@me/lists
```

With pagination:

```bash
GET /google-tasks/tasks/v1/users/@me/lists?maxResults=20
```

#### Get Task List

```bash
GET /google-tasks/tasks/v1/users/@me/lists/{tasklistId}
```

#### Create Task List

```bash
POST /google-tasks/tasks/v1/users/@me/lists
Content-Type: application/json

{
  "title": "New Task List"
}
```

#### Update Task List

```bash
PATCH /google-tasks/tasks/v1/users/@me/lists/{tasklistId}
Content-Type: application/json

{
  "title": "Updated Title"
}
```

#### Delete Task List

```bash
DELETE /google-tasks/tasks/v1/users/@me/lists/{tasklistId}
```

### Tasks

#### List Tasks

```bash
GET /google-tasks/tasks/v1/lists/{tasklistId}/tasks
```

With filters:

```bash
GET /google-tasks/tasks/v1/lists/{tasklistId}/tasks?showCompleted=true&showHidden=true&maxResults=50
```

With date filters:

```bash
GET /google-tasks/tasks/v1/lists/{tasklistId}/tasks?dueMin=2026-01-01T00:00:00Z&dueMax=2026-12-31T23:59:59Z
```

#### Get Task

```bash
GET /google-tasks/tasks/v1/lists/{tasklistId}/tasks/{taskId}
```

#### Create Task

```bash
POST /google-tasks/tasks/v1/lists/{tasklistId}/tasks
Content-Type: application/json

{
  "title": "New Task",
  "notes": "Task description",
  "due": "2026-03-01T00:00:00.000Z"
}
```

Create subtask:

```bash
POST /google-tasks/tasks/v1/lists/{tasklistId}/tasks?parent={parentTaskId}
Content-Type: application/json

{
  "title": "Subtask"
}
```

#### Update Task (partial)

```bash
PATCH /google-tasks/tasks/v1/lists/{tasklistId}/tasks/{taskId}
Content-Type: application/json

{
  "title": "Updated Title",
  "status": "completed"
}
```

#### Update Task (full replace)

```bash
PUT /google-tasks/tasks/v1/lists/{tasklistId}/tasks/{taskId}
Content-Type: application/json

{
  "title": "Replaced Task",
  "notes": "New notes",
  "status": "needsAction"
}
```

#### Delete Task

```bash
DELETE /google-tasks/tasks/v1/lists/{tasklistId}/tasks/{taskId}
```

#### Move Task

```bash
POST /google-tasks/tasks/v1/lists/{tasklistId}/tasks/{taskId}/move?previous={previousTaskId}
```

Make subtask:

```bash
POST /google-tasks/tasks/v1/lists/{tasklistId}/tasks/{taskId}/move?parent={parentTaskId}
```

#### Clear Completed Tasks

```bash
POST /google-tasks/tasks/v1/lists/{tasklistId}/clear
```

## Notes

- Authentication is automatic - the router injects the OAuth token
- Task list and task IDs are opaque base64-encoded strings
- Status values: "needsAction" or "completed"
- Dates must be in RFC 3339 format (e.g., `2026-01-15T00:00:00.000Z`)
- Maximum title length: 1024 characters
- Maximum notes length: 8192 characters

## Resources

- [Google Tasks API Overview](https://developers.google.com/workspace/tasks)
- [Tasks Reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)
- [TaskLists Reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists)
