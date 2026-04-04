# Box Routing Reference

**App name:** `box`
**Base URL proxied:** `api.box.com`

## API Path Pattern

```
/box/2.0/{resource}
```

## Common Endpoints

### Get Current User

```bash
GET /box/2.0/users/me
```

### Get User

```bash
GET /box/2.0/users/{user_id}
```

### Get Folder

```bash
GET /box/2.0/folders/{folder_id}
```

Root folder ID is `0`.

### List Folder Items

```bash
GET /box/2.0/folders/{folder_id}/items
GET /box/2.0/folders/{folder_id}/items?limit=100&offset=0
```

### Create Folder

```bash
POST /box/2.0/folders
Content-Type: application/json

{
  "name": "New Folder",
  "parent": {"id": "0"}
}
```

### Update Folder

```bash
PUT /box/2.0/folders/{folder_id}
Content-Type: application/json

{
  "name": "Updated Name",
  "description": "Description"
}
```

### Copy Folder

```bash
POST /box/2.0/folders/{folder_id}/copy
Content-Type: application/json

{
  "name": "Copied Folder",
  "parent": {"id": "0"}
}
```

### Delete Folder

```bash
DELETE /box/2.0/folders/{folder_id}
DELETE /box/2.0/folders/{folder_id}?recursive=true
```

### Get File

```bash
GET /box/2.0/files/{file_id}
```

### Download File

```bash
GET /box/2.0/files/{file_id}/content
```

### Update File

```bash
PUT /box/2.0/files/{file_id}
```

### Copy File

```bash
POST /box/2.0/files/{file_id}/copy
```

### Delete File

```bash
DELETE /box/2.0/files/{file_id}
```

### Create Shared Link

```bash
PUT /box/2.0/folders/{folder_id}
Content-Type: application/json

{
  "shared_link": {"access": "open"}
}
```

### List Collaborations

```bash
GET /box/2.0/folders/{folder_id}/collaborations
```

### Create Collaboration

```bash
POST /box/2.0/collaborations
Content-Type: application/json

{
  "item": {"type": "folder", "id": "123"},
  "accessible_by": {"type": "user", "login": "user@example.com"},
  "role": "editor"
}
```

### Search

```bash
GET /box/2.0/search?query=keyword
```

### Events

```bash
GET /box/2.0/events
```

### Trash

```bash
GET /box/2.0/folders/trash/items
DELETE /box/2.0/files/{file_id}/trash
DELETE /box/2.0/folders/{folder_id}/trash
```

### Collections

```bash
GET /box/2.0/collections
GET /box/2.0/collections/{collection_id}/items
```

### Recent Items

```bash
GET /box/2.0/recent_items
```

### Webhooks

```bash
GET /box/2.0/webhooks
POST /box/2.0/webhooks
DELETE /box/2.0/webhooks/{webhook_id}
```

## Pagination

Offset-based pagination:

```bash
GET /box/2.0/folders/0/items?limit=100&offset=0
```

Response:

```json
{
  "total_count": 250,
  "entries": [...],
  "offset": 0,
  "limit": 100
}
```

## Notes

- Root folder ID is `0`
- File uploads use `upload.box.com` (different base URL)
- Delete operations return 204 No Content
- Some operations require enterprise admin permissions
- Use `fields` parameter to select specific fields

## Resources

- [Box API Reference](https://developer.box.com/reference)
- [Box Developer Documentation](https://developer.box.com/guides)
