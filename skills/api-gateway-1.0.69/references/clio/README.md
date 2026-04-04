# Clio Routing Reference

**App name:** `clio`
**Base URL proxied:** `app.clio.com`

## API Path Pattern

```
/clio/api/v4/{resource}
```

## Field Selection

By default, Clio returns minimal fields (`id`, `etag`). Always specify fields:

```bash
GET /clio/api/v4/matters?fields=id,display_number,description,status
```

Nested resources use curly bracket syntax:

```bash
GET /clio/api/v4/activities?fields=id,type,matter{id,description}
```

## Common Endpoints

### Matters

#### List Matters

```bash
GET /clio/api/v4/matters?fields=id,display_number,description,status
```

#### Get Matter

```bash
GET /clio/api/v4/matters/{id}?fields=id,display_number,description,status,open_date
```

#### Create Matter

```bash
POST /clio/api/v4/matters
Content-Type: application/json

{
  "data": {
    "description": "New Legal Matter",
    "status": "open",
    "client": {"id": 12345}
  }
}
```

#### Update Matter

```bash
PATCH /clio/api/v4/matters/{id}
Content-Type: application/json

{
  "data": {
    "description": "Updated Description"
  }
}
```

#### Delete Matter

```bash
DELETE /clio/api/v4/matters/{id}
```

### Contacts

#### List Contacts

```bash
GET /clio/api/v4/contacts?fields=id,name,type,primary_email_address
```

#### Get Contact

```bash
GET /clio/api/v4/contacts/{id}?fields=id,name,type,first_name,last_name
```

#### Create Contact (Person)

```bash
POST /clio/api/v4/contacts
Content-Type: application/json

{
  "data": {
    "type": "Person",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

#### Create Contact (Company)

```bash
POST /clio/api/v4/contacts
Content-Type: application/json

{
  "data": {
    "type": "Company",
    "name": "Acme Corporation"
  }
}
```

#### Update Contact

```bash
PATCH /clio/api/v4/contacts/{id}
Content-Type: application/json

{
  "data": {
    "first_name": "Jane"
  }
}
```

#### Delete Contact

```bash
DELETE /clio/api/v4/contacts/{id}
```

### Activities

#### List Activities

```bash
GET /clio/api/v4/activities?fields=id,type,date,quantity,matter{id,description}
```

#### Get Activity

```bash
GET /clio/api/v4/activities/{id}?fields=id,type,date,quantity,note
```

#### Create Activity

```bash
POST /clio/api/v4/activities
Content-Type: application/json

{
  "data": {
    "type": "TimeEntry",
    "date": "2026-02-11",
    "quantity": 3600,
    "matter": {"id": 12345}
  }
}
```

#### Update Activity

```bash
PATCH /clio/api/v4/activities/{id}
Content-Type: application/json

{
  "data": {
    "note": "Updated note"
  }
}
```

#### Delete Activity

```bash
DELETE /clio/api/v4/activities/{id}
```

### Tasks

#### List Tasks

```bash
GET /clio/api/v4/tasks?fields=id,name,status,due_at,priority
```

#### Get Task

```bash
GET /clio/api/v4/tasks/{id}?fields=id,name,description,status,due_at
```

#### Create Task

Requires `assignee` with `id` and `type`:

```bash
POST /clio/api/v4/tasks
Content-Type: application/json

{
  "data": {
    "name": "Review contract",
    "due_at": "2026-02-15T17:00:00Z",
    "priority": "Normal",
    "assignee": {"id": 12345, "type": "User"},
    "matter": {"id": 67890}
  }
}
```

#### Update Task

```bash
PATCH /clio/api/v4/tasks/{id}
Content-Type: application/json

{
  "data": {
    "status": "complete"
  }
}
```

#### Delete Task

```bash
DELETE /clio/api/v4/tasks/{id}
```

### Calendar Entries

#### List Calendar Entries

```bash
GET /clio/api/v4/calendar_entries?fields=id,summary,start_at,end_at
```

#### Get Calendar Entry

```bash
GET /clio/api/v4/calendar_entries/{id}?fields=id,summary,description,start_at,end_at
```

#### Create Calendar Entry

Requires `calendar_owner` with `id` and `type`:

```bash
POST /clio/api/v4/calendar_entries
Content-Type: application/json

{
  "data": {
    "summary": "Client Meeting",
    "start_at": "2026-02-15T10:00:00Z",
    "end_at": "2026-02-15T11:00:00Z",
    "calendar_owner": {"id": 12345, "type": "User"}
  }
}
```

**Note:** Associating a matter during creation may return 404. Use PATCH to link matters after creation.

#### Update Calendar Entry

```bash
PATCH /clio/api/v4/calendar_entries/{id}
Content-Type: application/json

{
  "data": {
    "summary": "Updated Meeting"
  }
}
```

#### Delete Calendar Entry

```bash
DELETE /clio/api/v4/calendar_entries/{id}
```

### Documents

#### List Documents

```bash
GET /clio/api/v4/documents?fields=id,name,content_type,size
```

#### Get Document

```bash
GET /clio/api/v4/documents/{id}?fields=id,name,content_type,size,created_at
```

#### Download Document

```bash
GET /clio/api/v4/documents/{id}/download
```

### Users

#### Get Current User

```bash
GET /clio/api/v4/users/who_am_i?fields=id,name,email,enabled
```

#### List Users

```bash
GET /clio/api/v4/users?fields=id,name,email,enabled
```

### Bills

#### List Bills

```bash
GET /clio/api/v4/bills?fields=id,number,issued_at,due_at,total,balance,state
```

#### Get Bill

```bash
GET /clio/api/v4/bills/{id}?fields=id,number,total,balance,state
```

## Pagination

Clio uses cursor-based pagination:

```bash
GET /clio/api/v4/matters?fields=id,description&limit=50
```

Response includes pagination in `meta`:

```json
{
  "data": [...],
  "meta": {
    "paging": {
      "next": "https://app.clio.com/api/v4/matters?page_token=xyz123"
    }
  }
}
```

Use `page_token` for next page:

```bash
GET /clio/api/v4/matters?page_token=xyz123
```

## Notes

- Always specify `fields` parameter - defaults are minimal (`id`, `etag` only)
- Nested resources use curly brackets: `matter{id,description}`
- Only one level of nesting supported
- Contact types: `Person` or `Company`
- Task assignees require both `id` and `type` ("User" or "Contact")
- Calendar entries require `calendar_owner` with `id` and `type`; linking matters during creation may fail - use PATCH after creation
- Activity quantity is in seconds (3600 = 1 hour)
- Rate limit: 50 requests/minute during peak hours
- Contact limits: max 20 emails, phones, and addresses each
- Activities, Documents, and Bills endpoints require additional OAuth scopes

## Resources

- [Clio API Documentation](https://docs.developers.clio.com/api-reference/)
- [Clio Fields Guide](https://docs.developers.clio.com/api-docs/clio-manage/fields/)
- [Clio Rate Limits](https://docs.developers.clio.com/api-docs/clio-manage/rate-limits/)
