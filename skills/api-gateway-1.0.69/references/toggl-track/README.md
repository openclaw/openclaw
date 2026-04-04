# Toggl Track Routing Reference

**App name:** `toggl-track`
**Base URL proxied:** `api.track.toggl.com`

## API Path Pattern

```
/toggl-track/api/v9/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /toggl-track/api/v9/me
```

### List Workspaces

```bash
GET /toggl-track/api/v9/me/workspaces
```

### Get Workspace

```bash
GET /toggl-track/api/v9/workspaces/{workspace_id}
```

### List Workspace Users

```bash
GET /toggl-track/api/v9/workspaces/{workspace_id}/users
```

### List Time Entries

```bash
GET /toggl-track/api/v9/me/time_entries
GET /toggl-track/api/v9/me/time_entries?start_date=2026-02-01&end_date=2026-02-28
```

### Get Current Time Entry

```bash
GET /toggl-track/api/v9/me/time_entries/current
```

### Create Time Entry

```bash
POST /toggl-track/api/v9/workspaces/{workspace_id}/time_entries
Content-Type: application/json

{
  "description": "Working on task",
  "start": "2026-02-13T10:00:00Z",
  "duration": -1,
  "workspace_id": 21180405,
  "created_with": "maton-api"
}
```

### Stop Time Entry

```bash
PATCH /toggl-track/api/v9/workspaces/{workspace_id}/time_entries/{time_entry_id}/stop
```

### Update Time Entry

```bash
PUT /toggl-track/api/v9/workspaces/{workspace_id}/time_entries/{time_entry_id}
Content-Type: application/json

{
  "description": "Updated description"
}
```

### Delete Time Entry

```bash
DELETE /toggl-track/api/v9/workspaces/{workspace_id}/time_entries/{time_entry_id}
```

### List Projects

```bash
GET /toggl-track/api/v9/workspaces/{workspace_id}/projects
GET /toggl-track/api/v9/workspaces/{workspace_id}/projects?active=true
```

### Create Project

```bash
POST /toggl-track/api/v9/workspaces/{workspace_id}/projects
Content-Type: application/json

{
  "name": "New Project",
  "active": true,
  "color": "#0b83d9"
}
```

### Update Project

```bash
PUT /toggl-track/api/v9/workspaces/{workspace_id}/projects/{project_id}
Content-Type: application/json

{
  "name": "Updated Project"
}
```

### Delete Project

```bash
DELETE /toggl-track/api/v9/workspaces/{workspace_id}/projects/{project_id}
```

### List Clients

```bash
GET /toggl-track/api/v9/workspaces/{workspace_id}/clients
```

### Create Client

```bash
POST /toggl-track/api/v9/workspaces/{workspace_id}/clients
Content-Type: application/json

{
  "name": "New Client"
}
```

### Update Client

```bash
PUT /toggl-track/api/v9/workspaces/{workspace_id}/clients/{client_id}
Content-Type: application/json

{
  "name": "Updated Client"
}
```

### Delete Client

```bash
DELETE /toggl-track/api/v9/workspaces/{workspace_id}/clients/{client_id}
```

### List Tags

```bash
GET /toggl-track/api/v9/workspaces/{workspace_id}/tags
```

### Create Tag

```bash
POST /toggl-track/api/v9/workspaces/{workspace_id}/tags
Content-Type: application/json

{
  "name": "New Tag"
}
```

### Update Tag

```bash
PUT /toggl-track/api/v9/workspaces/{workspace_id}/tags/{tag_id}
Content-Type: application/json

{
  "name": "Updated Tag"
}
```

### Delete Tag

```bash
DELETE /toggl-track/api/v9/workspaces/{workspace_id}/tags/{tag_id}
```

## Notes

- Workspace IDs and time entry IDs are integers
- Duration is in seconds; use `-1` to start a running timer
- Timestamps use ISO 8601 format (e.g., `2026-02-13T19:58:43Z`)
- The `created_with` field is required when creating time entries
- Pagination uses `page` and `per_page` query parameters
- Time entries list supports `since`, `start_date`, and `end_date` filters

## Resources

- [Toggl Track API Documentation](https://engineering.toggl.com/docs/)
- [Time Entries API](https://engineering.toggl.com/docs/api/time_entries)
- [Projects API](https://engineering.toggl.com/docs/api/projects)
- [Clients API](https://engineering.toggl.com/docs/api/clients)
- [Tags API](https://engineering.toggl.com/docs/api/tags)
