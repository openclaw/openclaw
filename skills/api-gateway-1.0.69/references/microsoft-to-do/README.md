# Microsoft To Do Routing Reference

**App name:** `microsoft-to-do`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/microsoft-to-do/v1.0/me/todo/{resource}
```

All Microsoft To Do endpoints use the Microsoft Graph API under the `/me/todo/` path.

## Common Endpoints

### Task Lists

#### List All Task Lists

```bash
GET /microsoft-to-do/v1.0/me/todo/lists
```

#### Get Task List

```bash
GET /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}
```

#### Create Task List

```bash
POST /microsoft-to-do/v1.0/me/todo/lists
Content-Type: application/json

{
  "displayName": "My New List"
}
```

#### Update Task List

```bash
PATCH /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}
Content-Type: application/json

{
  "displayName": "Updated List Name"
}
```

#### Delete Task List

```bash
DELETE /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}
```

### Tasks

#### List Tasks

```bash
GET /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks
```

#### Get Task

```bash
GET /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}
```

#### Create Task

```bash
POST /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks
Content-Type: application/json

{
  "title": "New Task",
  "importance": "high",
  "status": "notStarted",
  "dueDateTime": {
    "dateTime": "2024-12-31T17:00:00",
    "timeZone": "UTC"
  }
}
```

#### Update Task

```bash
PATCH /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}
Content-Type: application/json

{
  "status": "completed"
}
```

#### Delete Task

```bash
DELETE /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}
```

### Checklist Items

#### List Checklist Items

```bash
GET /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/checklistItems
```

#### Create Checklist Item

```bash
POST /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/checklistItems
Content-Type: application/json

{
  "displayName": "Subtask name"
}
```

#### Update Checklist Item

```bash
PATCH /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/checklistItems/{checklistItemId}
Content-Type: application/json

{
  "isChecked": true
}
```

#### Delete Checklist Item

```bash
DELETE /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/checklistItems/{checklistItemId}
```

### Linked Resources

#### List Linked Resources

```bash
GET /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/linkedResources
```

#### Create Linked Resource

```bash
POST /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/linkedResources
Content-Type: application/json

{
  "webUrl": "https://example.com/item",
  "applicationName": "MyApp",
  "displayName": "Related Item"
}
```

#### Delete Linked Resource

```bash
DELETE /microsoft-to-do/v1.0/me/todo/lists/{todoTaskListId}/tasks/{taskId}/linkedResources/{linkedResourceId}
```

## Notes

- Task list IDs and task IDs are opaque base64-encoded strings
- Timestamps use ISO 8601 format in UTC by default
- The `dateTimeTimeZone` type requires both `dateTime` and `timeZone` fields
- Task `status` values: `notStarted`, `inProgress`, `completed`, `waitingOnOthers`, `deferred`
- Task `importance` values: `low`, `normal`, `high`
- Supports OData query parameters: `$select`, `$filter`, `$orderby`, `$top`, `$skip`
- Pagination uses `@odata.nextLink` for continuation

## Resources

- [Microsoft To Do API Overview](https://learn.microsoft.com/en-us/graph/api/resources/todo-overview)
- [todoTaskList Resource](https://learn.microsoft.com/en-us/graph/api/resources/todotasklist)
- [todoTask Resource](https://learn.microsoft.com/en-us/graph/api/resources/todotask)
