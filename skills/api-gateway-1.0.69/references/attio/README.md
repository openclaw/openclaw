# Attio Routing Reference

**App name:** `attio`
**Base URL proxied:** `api.attio.com`

## API Path Pattern

```
/attio/v2/{resource}
```

## Common Endpoints

### List Objects

```bash
GET /attio/v2/objects
```

### Get Object

```bash
GET /attio/v2/objects/{object}
```

### List Attributes

```bash
GET /attio/v2/objects/{object}/attributes
```

### Query Records

```bash
POST /attio/v2/objects/{object}/records/query
Content-Type: application/json

{
  "limit": 50,
  "offset": 0
}
```

### Get Record

```bash
GET /attio/v2/objects/{object}/records/{record_id}
```

### Create Record

```bash
POST /attio/v2/objects/{object}/records
Content-Type: application/json

{
  "data": {
    "values": {
      "name": [{"first_name": "John", "last_name": "Doe", "full_name": "John Doe"}],
      "email_addresses": ["john@example.com"]
    }
  }
}
```

### Update Record

```bash
PATCH /attio/v2/objects/{object}/records/{record_id}
Content-Type: application/json

{
  "data": {
    "values": {
      "job_title": "Engineer"
    }
  }
}
```

### Delete Record

```bash
DELETE /attio/v2/objects/{object}/records/{record_id}
```

### List Tasks

```bash
GET /attio/v2/tasks?limit=50
```

### Create Task

```bash
POST /attio/v2/tasks
Content-Type: application/json

{
  "data": {
    "content": "Task description",
    "format": "plaintext",
    "deadline_at": null,
    "assignees": [],
    "linked_records": []
  }
}
```

### List Workspace Members

```bash
GET /attio/v2/workspace_members
```

### Identify Self

```bash
GET /attio/v2/self
```

### Notes

#### List Notes

```bash
GET /attio/v2/notes?limit=50&parent_object={object}&parent_record_id={record_id}
```

#### Get Note

```bash
GET /attio/v2/notes/{note_id}
```

#### Create Note

```bash
POST /attio/v2/notes
Content-Type: application/json

{
  "data": {
    "format": "plaintext",
    "title": "Meeting Summary",
    "content": "Note content here",
    "parent_object": "companies",
    "parent_record_id": "{record_id}",
    "created_by_actor": {
      "type": "workspace-member",
      "id": "{workspace_member_id}"
    }
  }
}
```

#### Delete Note

```bash
DELETE /attio/v2/notes/{note_id}
```

### Comments

#### Create Comment on Record

```bash
POST /attio/v2/comments
Content-Type: application/json

{
  "data": {
    "format": "plaintext",
    "content": "Comment text",
    "author": {
      "type": "workspace-member",
      "id": "{workspace_member_id}"
    },
    "record": {
      "object": "companies",
      "record_id": "{record_id}"
    }
  }
}
```

#### Reply to Comment Thread

```bash
POST /attio/v2/comments
Content-Type: application/json

{
  "data": {
    "format": "plaintext",
    "content": "This is a reply",
    "author": {
      "type": "workspace-member",
      "id": "{workspace_member_id}"
    },
    "thread_id": "{thread_id}"
  }
}
```

### Lists

#### List All Lists

```bash
GET /attio/v2/lists
```

#### Get List

```bash
GET /attio/v2/lists/{list_id}
```

### List Entries

#### Query List Entries

```bash
POST /attio/v2/lists/{list}/entries/query
Content-Type: application/json

{
  "limit": 50,
  "offset": 0
}
```

#### Create List Entry

```bash
POST /attio/v2/lists/{list}/entries
Content-Type: application/json

{
  "data": {
    "parent_record_id": "{record_id}",
    "parent_object": "companies",
    "entry_values": {}
  }
}
```

#### Get List Entry

```bash
GET /attio/v2/lists/{list}/entries/{entry_id}
```

#### Update List Entry

```bash
PATCH /attio/v2/lists/{list}/entries/{entry_id}
Content-Type: application/json

{
  "data": {
    "entry_values": {
      "status": "Active"
    }
  }
}
```

#### Delete List Entry

```bash
DELETE /attio/v2/lists/{list}/entries/{entry_id}
```

### Meetings

#### List Meetings

```bash
GET /attio/v2/meetings?limit=50
```

#### Get Meeting

```bash
GET /attio/v2/meetings/{meeting_id}
```

### Call Recordings

#### List Call Recordings for Meeting

```bash
GET /attio/v2/meetings/{meeting_id}/call_recordings?limit=50
```

#### Get Call Recording

```bash
GET /attio/v2/meetings/{meeting_id}/call_recordings/{call_recording_id}
```

## Usage Notes

- Object slugs are lowercase snake_case (e.g., `people`, `companies`)
- Record IDs are UUIDs
- For personal-name attributes, include `full_name` when creating records
- Task creation requires `format`, `deadline_at`, `assignees`, and `linked_records` fields
- Note creation requires `format`, `content`, `parent_object`, and `parent_record_id`
- Comment creation requires `format`, `content`, `author`, plus one of `record`, `entry`, or `thread_id`
- Meetings use cursor-based pagination
- Rate limits: 100 read/sec, 25 write/sec
- Pagination uses `limit` and `offset` parameters (or `cursor` for meetings)

## Resources

- [Attio API Overview](https://docs.attio.com/rest-api/overview)
- [Attio API Reference](https://docs.attio.com/rest-api/endpoint-reference)
- [Records API](https://docs.attio.com/rest-api/endpoint-reference/records)
