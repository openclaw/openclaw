# OneNote Routing Reference

**App name:** `one-note`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/one-note/v1.0/me/onenote/{resource}
```

## Common Endpoints

### List Notebooks

```bash
GET /one-note/v1.0/me/onenote/notebooks
```

### Get Notebook

```bash
GET /one-note/v1.0/me/onenote/notebooks/{notebook_id}
```

### Create Notebook

```bash
POST /one-note/v1.0/me/onenote/notebooks
Content-Type: application/json

{
  "displayName": "New Notebook"
}
```

### List Notebooks with Sections

```bash
GET /one-note/v1.0/me/onenote/notebooks?$expand=sections,sectionGroups
```

### Copy Notebook

```bash
POST /one-note/v1.0/me/onenote/notebooks/{notebook_id}/copyNotebook
Content-Type: application/json

{
  "renameAs": "Copied Notebook"
}
```

### Get Recent Notebooks

```bash
GET /one-note/v1.0/me/onenote/notebooks/getRecentNotebooks(includePersonalNotebooks=true)
```

### List Sections

```bash
GET /one-note/v1.0/me/onenote/sections
```

### List Notebook Sections

```bash
GET /one-note/v1.0/me/onenote/notebooks/{notebook_id}/sections
```

### Create Section

```bash
POST /one-note/v1.0/me/onenote/notebooks/{notebook_id}/sections
Content-Type: application/json

{
  "displayName": "New Section"
}
```

### List Section Groups

```bash
GET /one-note/v1.0/me/onenote/sectionGroups
```

### Create Section Group

```bash
POST /one-note/v1.0/me/onenote/notebooks/{notebook_id}/sectionGroups
Content-Type: application/json

{
  "displayName": "New Section Group"
}
```

### List Pages

```bash
GET /one-note/v1.0/me/onenote/pages
```

### List Section Pages

```bash
GET /one-note/v1.0/me/onenote/sections/{section_id}/pages
```

### Get Page Content

```bash
GET /one-note/v1.0/me/onenote/pages/{page_id}/content
```

### Create Page

```bash
POST /one-note/v1.0/me/onenote/sections/{section_id}/pages
Content-Type: text/html

<!DOCTYPE html>
<html>
  <head><title>Page Title</title></head>
  <body><p>Content</p></body>
</html>
```

### Update Page Content

```bash
PATCH /one-note/v1.0/me/onenote/pages/{page_id}/content
Content-Type: application/json

[
  {
    "target": "body",
    "action": "append",
    "content": "<p>Appended content</p>"
  }
]
```

## OData Query Parameters

| Parameter  | Description                                  |
| ---------- | -------------------------------------------- |
| `$select`  | Select properties (`$select=id,displayName`) |
| `$expand`  | Expand relations (`$expand=sections`)        |
| `$filter`  | Filter results (`$filter=isDefault eq true`) |
| `$orderby` | Sort results                                 |
| `$top`     | Limit results                                |

## Notes

- Uses Microsoft Graph API v1.0
- Pages created with HTML (Content-Type: text/html)
- Page updates use PATCH with JSON operations
- Copy operations are asynchronous
- Use `$expand=sections,sectionGroups` to get full notebook structure

## Resources

- [OneNote API Overview](https://learn.microsoft.com/en-us/graph/integrate-with-onenote)
- [OneNote REST API Reference](https://learn.microsoft.com/en-us/graph/api/resources/onenote-api-overview)
