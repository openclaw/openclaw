# Wrike Routing Reference

**App name:** `wrike`
**Base URL proxied:** `www.wrike.com`

## API Path Pattern

```
/wrike/api/v4/{resource}
```

## Common Endpoints

### List Spaces

```bash
GET /wrike/api/v4/spaces
```

### Get Space

```bash
GET /wrike/api/v4/spaces/{spaceId}
```

### Get Folder Tree

```bash
GET /wrike/api/v4/folders
```

### Get Folders in Space

```bash
GET /wrike/api/v4/spaces/{spaceId}/folders
```

### Get Folder

```bash
GET /wrike/api/v4/folders/{folderId}
```

### Create Folder

```bash
POST /wrike/api/v4/folders/{parentFolderId}/folders
Content-Type: application/json

{
  "title": "New Folder"
}
```

### List Tasks

```bash
GET /wrike/api/v4/tasks
GET /wrike/api/v4/folders/{folderId}/tasks
GET /wrike/api/v4/spaces/{spaceId}/tasks
```

### Get Task

```bash
GET /wrike/api/v4/tasks/{taskId}
GET /wrike/api/v4/tasks/{taskId},{taskId},... (up to 100 IDs)
```

### Create Task

```bash
POST /wrike/api/v4/folders/{folderId}/tasks
Content-Type: application/json

{
  "title": "New Task",
  "description": "Task description",
  "importance": "Normal"
}
```

### Update Task

```bash
PUT /wrike/api/v4/tasks/{taskId}
Content-Type: application/json

{
  "title": "Updated Title",
  "importance": "High"
}
```

### Delete Task

```bash
DELETE /wrike/api/v4/tasks/{taskId}
```

### List Comments

```bash
GET /wrike/api/v4/comments
GET /wrike/api/v4/tasks/{taskId}/comments
GET /wrike/api/v4/folders/{folderId}/comments
```

### Create Comment

```bash
POST /wrike/api/v4/tasks/{taskId}/comments
Content-Type: application/json

{
  "text": "Comment text"
}
```

### List Attachments

```bash
GET /wrike/api/v4/attachments
GET /wrike/api/v4/tasks/{taskId}/attachments
```

### Download Attachment

```bash
GET /wrike/api/v4/attachments/{attachmentId}/download
```

### List Contacts

```bash
GET /wrike/api/v4/contacts
```

### List Groups

```bash
GET /wrike/api/v4/groups
```

### Create Group

```bash
POST /wrike/api/v4/groups
Content-Type: application/json

{
  "title": "New Group",
  "members": ["contactId"]
}
```

### List Workflows

```bash
GET /wrike/api/v4/workflows
```

### List Custom Fields

```bash
GET /wrike/api/v4/customfields
GET /wrike/api/v4/spaces/{spaceId}/customfields
```

### List Timelogs

```bash
GET /wrike/api/v4/timelogs
GET /wrike/api/v4/tasks/{taskId}/timelogs
```

### Create Timelog

```bash
POST /wrike/api/v4/tasks/{taskId}/timelogs
Content-Type: application/json

{
  "hours": 2,
  "trackedDate": "2026-03-10",
  "comment": "Work description"
}
```

### List Dependencies

```bash
GET /wrike/api/v4/tasks/{taskId}/dependencies
```

### List Approvals

```bash
GET /wrike/api/v4/approvals
GET /wrike/api/v4/tasks/{taskId}/approvals
```

### List Invitations

```bash
GET /wrike/api/v4/invitations
```

### List Work Schedules

```bash
GET /wrike/api/v4/workschedules
```

### Get User (Admin)

```bash
GET /wrike/api/v4/users/{userId}
```

### List Access Roles (Admin)

```bash
GET /wrike/api/v4/access_roles
```

### Get Audit Log (Admin)

```bash
GET /wrike/api/v4/audit_log
```

### Get Data Export (Admin)

```bash
GET /wrike/api/v4/data_export
```

## Response Format

All Wrike API responses follow this structure:

```json
{
  "kind": "[resource_type]",
  "data": [...]
}
```

## Notes

- Resource IDs are base64-encoded strings
- Many endpoints support batch operations with up to 100 comma-separated IDs
- Tasks use `customStatusId` to reference workflow statuses
- Projects are folders with additional properties (owners, dates, status)

## Resources

- [Wrike API Documentation](https://developers.wrike.com/)
- [API Overview](https://developers.wrike.com/overview/)
- [OAuth 2.0 Authorization](https://developers.wrike.com/oauth-20-authorization/)
