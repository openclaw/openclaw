# Google Drive Routing Reference

**App name:** `google-drive`
**Base URL proxied:** `www.googleapis.com`

## API Path Pattern

```
/google-drive/drive/v3/{endpoint}
```

## Common Endpoints

### List Files

```bash
GET /google-drive/drive/v3/files?pageSize=10
```

With query:

```bash
GET /google-drive/drive/v3/files?q=name%20contains%20'report'&pageSize=10
```

Only folders:

```bash
GET /google-drive/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'
```

Files in specific folder:

```bash
GET /google-drive/drive/v3/files?q='FOLDER_ID'+in+parents
```

With fields:

```bash
GET /google-drive/drive/v3/files?fields=files(id,name,mimeType,createdTime,modifiedTime,size)
```

### Get File Metadata

```bash
GET /google-drive/drive/v3/files/{fileId}?fields=id,name,mimeType,size,createdTime
```

### Download File Content

```bash
GET /google-drive/drive/v3/files/{fileId}?alt=media
```

### Export Google Docs (to PDF, DOCX, etc.)

```bash
GET /google-drive/drive/v3/files/{fileId}/export?mimeType=application/pdf
```

### Create File (metadata only)

```bash
POST /google-drive/drive/v3/files
Content-Type: application/json

{
  "name": "New Document",
  "mimeType": "application/vnd.google-apps.document"
}
```

### Create Folder

```bash
POST /google-drive/drive/v3/files
Content-Type: application/json

{
  "name": "New Folder",
  "mimeType": "application/vnd.google-apps.folder"
}
```

### Update File Metadata

```bash
PATCH /google-drive/drive/v3/files/{fileId}
Content-Type: application/json

{
  "name": "Renamed File"
}
```

### Move File to Folder

```bash
PATCH /google-drive/drive/v3/files/{fileId}?addParents=NEW_FOLDER_ID&removeParents=OLD_FOLDER_ID
```

### Delete File

```bash
DELETE /google-drive/drive/v3/files/{fileId}
```

### Copy File

```bash
POST /google-drive/drive/v3/files/{fileId}/copy
Content-Type: application/json

{
  "name": "Copy of File"
}
```

### Create Permission (Share File)

```bash
POST /google-drive/drive/v3/files/{fileId}/permissions
Content-Type: application/json

{
  "role": "reader",
  "type": "user",
  "emailAddress": "user@example.com"
}
```

## File Uploads

Upload endpoints use a different path pattern: `/google-drive/upload/drive/v3/files`

### Simple Upload (up to 5MB)

```bash
POST /google-drive/upload/drive/v3/files?uploadType=media
Content-Type: text/plain

<file content>
```

### Multipart Upload (with metadata, up to 5MB)

```bash
POST /google-drive/upload/drive/v3/files?uploadType=multipart
Content-Type: multipart/related; boundary=boundary

--boundary
Content-Type: application/json

{"name": "myfile.txt"}
--boundary
Content-Type: text/plain

<file content>
--boundary--
```

### Resumable Upload (for large files)

```bash
# Step 1: Initiate session
POST /google-drive/upload/drive/v3/files?uploadType=resumable
Content-Type: application/json
X-Upload-Content-Type: application/octet-stream
X-Upload-Content-Length: <file_size>

{"name": "large_file.bin"}

# Response includes Location header with upload URI
# Step 2: Upload content to that URI
```

### Update File Content

```bash
PATCH /google-drive/upload/drive/v3/files/{fileId}?uploadType=media
Content-Type: text/plain

<new file content>
```

## Query Operators

Use in the `q` parameter:

- `name = 'exact name'`
- `name contains 'partial'`
- `mimeType = 'application/pdf'`
- `'folderId' in parents`
- `trashed = false`
- `modifiedTime > '2024-01-01T00:00:00'`

Combine with `and`:

```
name contains 'report' and mimeType = 'application/pdf'
```

## Common MIME Types

- `application/vnd.google-apps.document` - Google Docs
- `application/vnd.google-apps.spreadsheet` - Google Sheets
- `application/vnd.google-apps.presentation` - Google Slides
- `application/vnd.google-apps.folder` - Folder
- `application/pdf` - PDF

## Notes

- Authentication is automatic - the router injects the OAuth token
- Use `fields` parameter to limit response data
- Pagination uses `pageToken` from previous response's `nextPageToken`
- Upload endpoints use `/upload/drive/v3/files` path (note the `/upload` prefix)
- Use `uploadType=resumable` for files larger than 5MB
- Resumable uploads support chunking (256KB minimum, 5MB recommended)

## Resources

- [API Overview](https://developers.google.com/workspace/drive/api/reference/rest/v3#rest-resource:-v3.about)
- [List Files](https://developers.google.com/drive/api/reference/rest/v3/files/list)
- [Get File](https://developers.google.com/drive/api/reference/rest/v3/files/get)
- [Create File](https://developers.google.com/drive/api/reference/rest/v3/files/create)
- [Update File](https://developers.google.com/drive/api/reference/rest/v3/files/update)
- [Delete File](https://developers.google.com/drive/api/reference/rest/v3/files/delete)
- [Copy File](https://developers.google.com/drive/api/reference/rest/v3/files/copy)
- [Export File](https://developers.google.com/drive/api/reference/rest/v3/files/export)
- [Upload Files](https://developers.google.com/drive/api/guides/manage-uploads)
- [Resumable Uploads](https://developers.google.com/drive/api/guides/manage-uploads#resumable)
- [Create Permission](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create)
- [Search Query Syntax](https://developers.google.com/drive/api/guides/search-files)
