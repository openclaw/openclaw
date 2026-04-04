# OneDrive Routing Reference

**App name:** `one-drive`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/one-drive/v1.0/me/drive/{resource}
```

## Common Endpoints

### Get User's Drive

```bash
GET /one-drive/v1.0/me/drive
```

### List Drives

```bash
GET /one-drive/v1.0/me/drives
```

### Get Drive Root

```bash
GET /one-drive/v1.0/me/drive/root
```

### List Root Children

```bash
GET /one-drive/v1.0/me/drive/root/children
```

### Get Item by ID

```bash
GET /one-drive/v1.0/me/drive/items/{item-id}
```

### Get Item by Path

```bash
GET /one-drive/v1.0/me/drive/root:/Documents/file.txt
```

### List Folder Children by Path

```bash
GET /one-drive/v1.0/me/drive/root:/Documents:/children
```

### Create Folder

```bash
POST /one-drive/v1.0/me/drive/root/children
Content-Type: application/json

{
  "name": "New Folder",
  "folder": {}
}
```

### Upload File (Simple - up to 4MB)

```bash
PUT /one-drive/v1.0/me/drive/root:/filename.txt:/content
Content-Type: text/plain

{file content}
```

### Delete Item

```bash
DELETE /one-drive/v1.0/me/drive/items/{item-id}
```

### Create Sharing Link

```bash
POST /one-drive/v1.0/me/drive/items/{item-id}/createLink
Content-Type: application/json

{
  "type": "view",
  "scope": "anonymous"
}
```

### Search Files

```bash
GET /one-drive/v1.0/me/drive/root/search(q='query')
```

### Special Folders

```bash
GET /one-drive/v1.0/me/drive/special/documents
GET /one-drive/v1.0/me/drive/special/photos
```

### Recent Files

```bash
GET /one-drive/v1.0/me/drive/recent
```

### Shared With Me

```bash
GET /one-drive/v1.0/me/drive/sharedWithMe
```

## Notes

- Authentication is automatic - the router injects the OAuth token
- Uses Microsoft Graph API (`graph.microsoft.com`)
- Use colon (`:`) syntax for path-based addressing
- Simple uploads limited to 4MB; use resumable upload for larger files
- Download URLs in `@microsoft.graph.downloadUrl` are pre-authenticated
- Supports OData query parameters: `$select`, `$expand`, `$filter`, `$orderby`, `$top`

## Resources

- [OneDrive Developer Documentation](https://learn.microsoft.com/en-us/onedrive/developer/)
- [Microsoft Graph API Reference](https://learn.microsoft.com/en-us/graph/api/overview)
- [DriveItem Resource](https://learn.microsoft.com/en-us/graph/api/resources/driveitem)
