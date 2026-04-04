# Clockify Routing Reference

**App name:** `clockify`
**Base URL proxied:** `api.clockify.me`

## API Path Pattern

```
/clockify/api/v1/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /clockify/api/v1/user
```

### List Workspaces

```bash
GET /clockify/api/v1/workspaces
```

### Get Workspace

```bash
GET /clockify/api/v1/workspaces/{workspaceId}
```

### List Workspace Users

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/users
```

### List Projects

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/projects
```

### Get Project

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/projects/{projectId}
```

### Create Project

```bash
POST /clockify/api/v1/workspaces/{workspaceId}/projects
Content-Type: application/json

{
  "name": "My Project",
  "isPublic": true,
  "clientId": "optional-client-id"
}
```

### Update Project

```bash
PUT /clockify/api/v1/workspaces/{workspaceId}/projects/{projectId}
Content-Type: application/json

{
  "name": "Updated Project Name",
  "archived": true
}
```

### Delete Project

```bash
DELETE /clockify/api/v1/workspaces/{workspaceId}/projects/{projectId}
```

### List Clients

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/clients
```

### Create Client

```bash
POST /clockify/api/v1/workspaces/{workspaceId}/clients
Content-Type: application/json

{
  "name": "Client Name",
  "address": "123 Main St",
  "note": "Client notes"
}
```

### List Tags

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/tags
```

### Create Tag

```bash
POST /clockify/api/v1/workspaces/{workspaceId}/tags
Content-Type: application/json

{
  "name": "urgent"
}
```

### List Tasks on Project

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks
```

### Create Task

```bash
POST /clockify/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks
Content-Type: application/json

{
  "name": "Task Name",
  "assigneeIds": ["user-id"],
  "estimate": "PT2H",
  "billable": true
}
```

### Get User's Time Entries

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/user/{userId}/time-entries
```

### Create Time Entry

```bash
POST /clockify/api/v1/workspaces/{workspaceId}/time-entries
Content-Type: application/json

{
  "start": "2026-02-13T09:00:00Z",
  "end": "2026-02-13T10:00:00Z",
  "description": "Working on task",
  "projectId": "project-id",
  "taskId": "task-id",
  "tagIds": ["tag-id"],
  "billable": true
}
```

### Get Time Entry

```bash
GET /clockify/api/v1/workspaces/{workspaceId}/time-entries/{timeEntryId}
```

### Update Time Entry

```bash
PUT /clockify/api/v1/workspaces/{workspaceId}/time-entries/{timeEntryId}
Content-Type: application/json

{
  "description": "Updated description",
  "end": "2026-02-13T11:00:00Z"
}
```

### Delete Time Entry

```bash
DELETE /clockify/api/v1/workspaces/{workspaceId}/time-entries/{timeEntryId}
```

### Stop Running Timer

```bash
PATCH /clockify/api/v1/workspaces/{workspaceId}/user/{userId}/time-entries
Content-Type: application/json

{
  "end": "2026-02-13T17:00:00Z"
}
```

## Notes

- All IDs are strings
- Timestamps must be in ISO 8601 format with UTC timezone (e.g., `2026-02-13T09:00:00Z`)
- Duration format uses ISO 8601 duration (e.g., `PT1H` for 1 hour, `PT30M` for 30 minutes)
- Cannot delete active projects or tasks - must archive them first
- Page-based pagination with `page` and `page-size` query parameters
- Response includes `Last-Page` header indicating if more pages exist
- Rate limit: 50 requests per second per workspace

## Resources

- [Clockify API Documentation](https://docs.clockify.me/)
- [Time Entry API](https://docs.clockify.me/#tag/Time-entry)
- [Project API](https://docs.clockify.me/#tag/Project)
- [Workspace API](https://docs.clockify.me/#tag/Workspace)
- [User API](https://docs.clockify.me/#tag/User)
