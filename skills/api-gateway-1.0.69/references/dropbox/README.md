# Dropbox Routing Reference

**App name:** `dropbox`
**Base URL proxied:** `api.dropboxapi.com`

## API Path Pattern

```
/dropbox/2/{endpoint}
```

**Important:** All Dropbox API v2 endpoints use HTTP POST with JSON request bodies.

## Common Endpoints

### Users

#### Get Current Account

```bash
POST /dropbox/2/users/get_current_account
Content-Type: application/json

null
```

#### Get Space Usage

```bash
POST /dropbox/2/users/get_space_usage
Content-Type: application/json

null
```

### Files

#### List Folder

```bash
POST /dropbox/2/files/list_folder
Content-Type: application/json

{
  "path": ""
}
```

Use empty string `""` for root folder.

#### Continue Listing

```bash
POST /dropbox/2/files/list_folder/continue
Content-Type: application/json

{
  "cursor": "..."
}
```

#### Get Metadata

```bash
POST /dropbox/2/files/get_metadata
Content-Type: application/json

{
  "path": "/document.pdf"
}
```

#### Create Folder

```bash
POST /dropbox/2/files/create_folder_v2
Content-Type: application/json

{
  "path": "/New Folder",
  "autorename": false
}
```

#### Copy

```bash
POST /dropbox/2/files/copy_v2
Content-Type: application/json

{
  "from_path": "/source/file.pdf",
  "to_path": "/destination/file.pdf"
}
```

#### Move

```bash
POST /dropbox/2/files/move_v2
Content-Type: application/json

{
  "from_path": "/old/file.pdf",
  "to_path": "/new/file.pdf"
}
```

#### Delete

```bash
POST /dropbox/2/files/delete_v2
Content-Type: application/json

{
  "path": "/file-to-delete.pdf"
}
```

#### Get Temporary Link

```bash
POST /dropbox/2/files/get_temporary_link
Content-Type: application/json

{
  "path": "/document.pdf"
}
```

### Search

#### Search Files

```bash
POST /dropbox/2/files/search_v2
Content-Type: application/json

{
  "query": "document"
}
```

### Revisions

#### List Revisions

```bash
POST /dropbox/2/files/list_revisions
Content-Type: application/json

{
  "path": "/document.pdf"
}
```

### Tags

#### Get Tags

```bash
POST /dropbox/2/files/tags/get
Content-Type: application/json

{
  "paths": ["/document.pdf"]
}
```

#### Add Tag

```bash
POST /dropbox/2/files/tags/add
Content-Type: application/json

{
  "path": "/document.pdf",
  "tag_text": "important"
}
```

#### Remove Tag

```bash
POST /dropbox/2/files/tags/remove
Content-Type: application/json

{
  "path": "/document.pdf",
  "tag_text": "important"
}
```

## Pagination

Dropbox uses cursor-based pagination:

```bash
POST /dropbox/2/files/list_folder
# Response includes "cursor" and "has_more": true/false

POST /dropbox/2/files/list_folder/continue
# Use cursor from previous response
```

## Notes

- All endpoints use POST method
- Request bodies are JSON
- Use empty string `""` for root folder path
- Paths are case-insensitive but case-preserving
- Tag text must match pattern `[\w]+` (alphanumeric and underscores)
- Temporary links expire after 4 hours

## Resources

- [Dropbox HTTP API Overview](https://www.dropbox.com/developers/documentation/http/overview)
- [Dropbox API Explorer](https://dropbox.github.io/dropbox-api-v2-explorer/)
- [DBX File Access Guide](https://developers.dropbox.com/dbx-file-access-guide)
