# SharePoint Routing Reference

**App name:** `sharepoint`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/sharepoint/v1.0/sites/{site_id}
/sharepoint/v1.0/sites/{site_id}/lists
/sharepoint/v1.0/sites/{site_id}/lists/{list_id}/items
/sharepoint/v1.0/sites/{site_id}/drives
/sharepoint/v1.0/drives/{drive_id}/root/children
/sharepoint/v1.0/drives/{drive_id}/items/{item_id}
```

## Sites

### Get Root Site

```bash
GET /sharepoint/v1.0/sites/root
```

### Get Site by ID

```bash
GET /sharepoint/v1.0/sites/{site_id}
```

Site IDs follow the format: `{hostname},{site-guid},{web-guid}`

### Get Site by Hostname

```bash
GET /sharepoint/v1.0/sites/{hostname}:/
GET /sharepoint/v1.0/sites/{hostname}:/{site-path}
```

### Search Sites

```bash
GET /sharepoint/v1.0/sites?search={query}
```

### List Subsites

```bash
GET /sharepoint/v1.0/sites/{site_id}/sites
```

### Get Site Columns

```bash
GET /sharepoint/v1.0/sites/{site_id}/columns
```

### Get Followed Sites

```bash
GET /sharepoint/v1.0/me/followedSites
```

## Lists

### List Site Lists

```bash
GET /sharepoint/v1.0/sites/{site_id}/lists
```

### Get List

```bash
GET /sharepoint/v1.0/sites/{site_id}/lists/{list_id}
```

### List Columns

```bash
GET /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/columns
```

### List Content Types

```bash
GET /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/contentTypes
```

### List Items

```bash
GET /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/items
GET /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/items?$expand=fields
```

### Create List Item

```bash
POST /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/items
Content-Type: application/json

{
  "fields": {
    "Title": "New Item",
    "Description": "Item description"
  }
}
```

### Update List Item

```bash
PATCH /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/items/{item_id}/fields
Content-Type: application/json

{
  "Title": "Updated Title"
}
```

### Delete List Item

```bash
DELETE /sharepoint/v1.0/sites/{site_id}/lists/{list_id}/items/{item_id}
```

## Drives (Document Libraries)

### List Site Drives

```bash
GET /sharepoint/v1.0/sites/{site_id}/drives
```

### Get Default Drive

```bash
GET /sharepoint/v1.0/sites/{site_id}/drive
```

### Get Drive by ID

```bash
GET /sharepoint/v1.0/drives/{drive_id}
```

## Files and Folders

### List Root Contents

```bash
GET /sharepoint/v1.0/drives/{drive_id}/root/children
```

### Get Item by ID

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}
```

### Get Item by Path

```bash
GET /sharepoint/v1.0/drives/{drive_id}/root:/{path}
```

### List Folder Contents

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{folder_id}/children
```

### Download File

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/content
GET /sharepoint/v1.0/drives/{drive_id}/root:/{path}:/content
```

### Upload File

```bash
PUT /sharepoint/v1.0/drives/{drive_id}/root:/{filename}:/content
Content-Type: application/octet-stream
```

### Create Folder

```bash
POST /sharepoint/v1.0/drives/{drive_id}/root/children
Content-Type: application/json

{
  "name": "New Folder",
  "folder": {},
  "@microsoft.graph.conflictBehavior": "rename"
}
```

### Rename/Move Item

```bash
PATCH /sharepoint/v1.0/drives/{drive_id}/items/{item_id}
Content-Type: application/json

{
  "name": "new-name.txt"
}
```

### Copy Item

```bash
POST /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/copy
Content-Type: application/json

{
  "name": "copied-file.txt"
}
```

### Delete Item

```bash
DELETE /sharepoint/v1.0/drives/{drive_id}/items/{item_id}
```

### Search Files

```bash
GET /sharepoint/v1.0/drives/{drive_id}/root/search(q='{query}')
```

### Track Changes (Delta)

```bash
GET /sharepoint/v1.0/drives/{drive_id}/root/delta
```

## Sharing and Permissions

### Get Permissions

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/permissions
```

### Create Sharing Link

```bash
POST /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/createLink
Content-Type: application/json

{
  "type": "view",
  "scope": "organization"
}
```

## Versions

### List Versions

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/versions
```

### Get Version

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/versions/{version_id}
```

### Download Version Content

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/versions/{version_id}/content
```

## Thumbnails

### Get Thumbnails

```bash
GET /sharepoint/v1.0/drives/{drive_id}/items/{item_id}/thumbnails
```

## Query Parameters

- `$select` - Select specific properties
- `$expand` - Expand related entities (e.g., `fields` for list items)
- `$filter` - Filter results
- `$orderby` - Sort results
- `$top` - Limit results
- `$skip` - Skip results (pagination)

## Notes

- Site IDs follow the format: `{hostname},{site-guid},{web-guid}`
- Drive IDs with `!` must be URL-encoded: `b!abc123` → `b%21abc123`
- File uploads via PUT limited to 4MB; use upload sessions for larger files
- Copy operations are asynchronous (returns 202)
- Deleted items go to the SharePoint recycle bin

## Resources

- [SharePoint Sites API](https://learn.microsoft.com/en-us/graph/api/resources/sharepoint)
- [DriveItem API](https://learn.microsoft.com/en-us/graph/api/resources/driveitem)
- [List API](https://learn.microsoft.com/en-us/graph/api/resources/list)
