# Podio Routing Reference

**App name:** `podio`
**Base URL proxied:** `api.podio.com`

## API Path Pattern

```
/podio/{resource}/{id}/
```

Note: Many Podio endpoints use trailing slashes.

## Common Endpoints

### Organizations

#### List Organizations

```bash
GET /podio/org/
```

#### Get Organization

```bash
GET /podio/org/{org_id}
```

### Spaces (Workspaces)

#### List Spaces in Organization

```bash
GET /podio/space/org/{org_id}/
```

#### Get Space

```bash
GET /podio/space/{space_id}
```

#### Create Space

```bash
POST /podio/org/{org_id}/space/
Content-Type: application/json

{
  "name": "New Workspace",
  "privacy": "closed"
}
```

### Applications

#### List Apps in Space

```bash
GET /podio/app/space/{space_id}/
```

#### Get App

```bash
GET /podio/app/{app_id}
```

### Items

#### Filter Items

```bash
POST /podio/item/app/{app_id}/filter/
Content-Type: application/json

{
  "limit": 30,
  "offset": 0,
  "sort_by": "created_on",
  "sort_desc": true,
  "filters": {
    "status": [1, 2]
  }
}
```

#### Get Item

```bash
GET /podio/item/{item_id}
```

#### Create Item

```bash
POST /podio/item/app/{app_id}/
Content-Type: application/json

{
  "fields": {
    "title": "New Item",
    "status": 1
  }
}
```

#### Update Item

```bash
PUT /podio/item/{item_id}
Content-Type: application/json

{
  "fields": {
    "title": "Updated Title"
  }
}
```

#### Delete Item

```bash
DELETE /podio/item/{item_id}
```

### Tasks

Tasks require at least one filter: org, space, app, responsible, reference, created_by, or completed_by.

#### List Tasks

```bash
GET /podio/task/?org={org_id}
GET /podio/task/?space={space_id}
GET /podio/task/?app={app_id}&completed=false
```

#### Get Task

```bash
GET /podio/task/{task_id}
```

#### Create Task

```bash
POST /podio/task/
Content-Type: application/json

{
  "text": "Task description",
  "due_date": "2026-03-15",
  "ref_type": "item",
  "ref_id": 3250776079
}
```

#### Complete Task

```bash
POST /podio/task/{task_id}/complete
```

#### Delete Task

```bash
DELETE /podio/task/{task_id}
```

### Comments

#### Get Comments on Object

```bash
GET /podio/comment/{type}/{id}/
```

Where `{type}` is: item, task, status, etc.

#### Add Comment

```bash
POST /podio/comment/{type}/{id}
Content-Type: application/json

{
  "value": "Comment text"
}
```

### User

#### Get User Status

```bash
GET /podio/user/status
```

## Pagination

Podio uses offset-based pagination:

```json
{
  "limit": 30,
  "offset": 0
}
```

Response includes counts:

```json
{
  "total": 150,
  "filtered": 45,
  "items": [...]
}
```

## Notes

- Organization, space, app, and item IDs are integers
- Many endpoints use trailing slashes (e.g., `/org/`, `/filter/`)
- Category/status fields use option IDs (integers), not text values
- Field values can be specified by field_id or external_id
- Deleting an item cascades to associated tasks
- Tasks require at least one filter parameter
- Use `silent=true` to suppress notifications
- Use `hook=false` to skip webhook triggers

## Resources

- [Podio API Documentation](https://developers.podio.com/doc)
- [Items API](https://developers.podio.com/doc/items)
- [Tasks API](https://developers.podio.com/doc/tasks)
- [Applications API](https://developers.podio.com/doc/applications)
- [Spaces API](https://developers.podio.com/doc/spaces)
