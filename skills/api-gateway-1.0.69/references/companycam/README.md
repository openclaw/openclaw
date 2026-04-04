# CompanyCam Routing Reference

**App name:** `companycam`
**Base URL proxied:** `api.companycam.com`

## API Path Pattern

```
/companycam/v2/{resource}
```

## Common Endpoints

### Company

#### Get Company

```bash
GET /companycam/v2/company
```

### Users

#### Get Current User

```bash
GET /companycam/v2/users/current
```

#### List Users

```bash
GET /companycam/v2/users
```

#### Create User

```bash
POST /companycam/v2/users
```

#### Get User

```bash
GET /companycam/v2/users/{id}
```

#### Update User

```bash
PUT /companycam/v2/users/{id}
```

#### Delete User

```bash
DELETE /companycam/v2/users/{id}
```

### Projects

#### List Projects

```bash
GET /companycam/v2/projects
```

#### Create Project

```bash
POST /companycam/v2/projects
```

#### Get Project

```bash
GET /companycam/v2/projects/{id}
```

#### Update Project

```bash
PUT /companycam/v2/projects/{id}
```

#### Delete Project

```bash
DELETE /companycam/v2/projects/{id}
```

#### Archive Project

```bash
PATCH /companycam/v2/projects/{id}/archive
```

#### Restore Project

```bash
PUT /companycam/v2/projects/{id}/restore
```

### Project Photos

#### List Project Photos

```bash
GET /companycam/v2/projects/{project_id}/photos
```

#### Add Photo to Project

```bash
POST /companycam/v2/projects/{project_id}/photos
```

### Project Comments

#### List Project Comments

```bash
GET /companycam/v2/projects/{project_id}/comments
```

#### Add Project Comment

```bash
POST /companycam/v2/projects/{project_id}/comments
```

### Project Labels

#### List Project Labels

```bash
GET /companycam/v2/projects/{project_id}/labels
```

#### Add Labels

```bash
POST /companycam/v2/projects/{project_id}/labels
```

### Project Documents

#### List Documents

```bash
GET /companycam/v2/projects/{project_id}/documents
```

#### Upload Document

```bash
POST /companycam/v2/projects/{project_id}/documents
```

### Photos

#### List All Photos

```bash
GET /companycam/v2/photos
```

#### Get Photo

```bash
GET /companycam/v2/photos/{id}
```

#### Update Photo

```bash
PUT /companycam/v2/photos/{id}
```

#### Delete Photo

```bash
DELETE /companycam/v2/photos/{id}
```

### Tags

#### List Tags

```bash
GET /companycam/v2/tags
```

#### Create Tag

```bash
POST /companycam/v2/tags
```

#### Get Tag

```bash
GET /companycam/v2/tags/{id}
```

#### Update Tag

```bash
PUT /companycam/v2/tags/{id}
```

#### Delete Tag

```bash
DELETE /companycam/v2/tags/{id}
```

### Groups

#### List Groups

```bash
GET /companycam/v2/groups
```

#### Create Group

```bash
POST /companycam/v2/groups
```

#### Get Group

```bash
GET /companycam/v2/groups/{id}
```

#### Update Group

```bash
PUT /companycam/v2/groups/{id}
```

#### Delete Group

```bash
DELETE /companycam/v2/groups/{id}
```

### Checklists

#### List Checklists

```bash
GET /companycam/v2/checklists
```

### Webhooks

#### List Webhooks

```bash
GET /companycam/v2/webhooks
```

#### Create Webhook

```bash
POST /companycam/v2/webhooks
```

#### Get Webhook

```bash
GET /companycam/v2/webhooks/{id}
```

#### Update Webhook

```bash
PUT /companycam/v2/webhooks/{id}
```

#### Delete Webhook

```bash
DELETE /companycam/v2/webhooks/{id}
```

## Query Parameters

- `page` - Page number (default: 1)
- `per_page` - Results per page (default: 25)
- `query` - Search query (projects)
- `status` - Filter by status
- `modified_since` - Unix timestamp for filtering

## Notes

- IDs are returned as strings
- Timestamps are Unix timestamps (seconds since epoch)
- Comments must be wrapped in a `comment` object
- Webhooks use `scopes` parameter (not `events`)
- Rate limits: 240 GET/min, 100 POST/PUT/DELETE/min

## Resources

- [CompanyCam API Documentation](https://docs.companycam.com)
