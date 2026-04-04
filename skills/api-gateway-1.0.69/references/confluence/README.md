# Confluence Routing Reference

**App name:** `confluence`
**Base URL proxied:** `api.atlassian.com`

## Getting Cloud ID

Confluence Cloud requires a cloud ID in the API path. First, get accessible resources:

```bash
GET /confluence/oauth/token/accessible-resources
```

Response:

```json
[{
  "id": "62909843-b784-4c35-b770-e4e2a26f024b",
  "url": "https://yoursite.atlassian.net",
  "name": "yoursite",
  "scopes": ["read:confluence-content.all", "write:confluence-content", ...]
}]
```

## API Path Pattern

V2 API (recommended):

```
/confluence/ex/confluence/{cloudId}/wiki/api/v2/{endpoint}
```

V1 REST API (limited):

```
/confluence/ex/confluence/{cloudId}/wiki/rest/api/{endpoint}
```

## Common Endpoints (V2 API)

### Pages

#### List Pages

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages?space-id={spaceId}
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages?limit=25
```

#### Get Page

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}?body-format=storage
```

#### Create Page

```bash
POST /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages
Content-Type: application/json

{
  "spaceId": "98306",
  "status": "current",
  "title": "Page Title",
  "body": {
    "representation": "storage",
    "value": "<p>Page content</p>"
  }
}
```

#### Update Page

```bash
PUT /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}
Content-Type: application/json

{
  "id": "98391",
  "status": "current",
  "title": "Updated Title",
  "body": {
    "representation": "storage",
    "value": "<p>Updated content</p>"
  },
  "version": {"number": 2}
}
```

#### Delete Page

```bash
DELETE /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}
```

#### Get Page Children

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}/children
```

#### Get Page Labels

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}/labels
```

#### Get Page Comments

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}/footer-comments
```

### Spaces

#### List Spaces

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/spaces
```

#### Get Space

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/spaces/{spaceId}
```

#### Get Space Pages

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/spaces/{spaceId}/pages
```

### Blogposts

#### List Blogposts

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/blogposts
```

#### Create Blogpost

```bash
POST /confluence/ex/confluence/{cloudId}/wiki/api/v2/blogposts
Content-Type: application/json

{
  "spaceId": "98306",
  "title": "Blog Post Title",
  "body": {
    "representation": "storage",
    "value": "<p>Blog content</p>"
  }
}
```

### Comments

#### List Footer Comments

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/footer-comments
```

#### Create Footer Comment

```bash
POST /confluence/ex/confluence/{cloudId}/wiki/api/v2/footer-comments
Content-Type: application/json

{
  "pageId": "98391",
  "body": {
    "representation": "storage",
    "value": "<p>Comment text</p>"
  }
}
```

### Attachments

#### List Attachments

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/attachments
```

#### Get Page Attachments

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/pages/{pageId}/attachments
```

### Tasks

#### List Tasks

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/api/v2/tasks
```

### User (V1 API)

#### Get Current User

```bash
GET /confluence/ex/confluence/{cloudId}/wiki/rest/api/user/current
```

## Notes

- Always fetch cloud ID first using `/oauth/token/accessible-resources`
- V2 API is recommended for most operations
- Content uses Confluence storage format (XML-like): `<p>Paragraph</p>`
- When updating pages, you must increment the version number
- DELETE operations return 204 No Content
- Pagination uses cursor-based approach with `_links.next` containing the cursor value

## Resources

- [Confluence REST API V2 Introduction](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [Page Operations](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
- [Space Operations](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/)
- [Blogpost Operations](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-blog-post/)
- [Comment Operations](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/)
- [Confluence Storage Format](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html)
