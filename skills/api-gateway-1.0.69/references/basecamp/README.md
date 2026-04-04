# Basecamp Routing Reference

**App name:** `basecamp`
**Base URL proxied:** `3.basecampapi.com/{account_id}`

Note: The gateway automatically injects the account ID from the OAuth connection.

## API Path Pattern

```
/basecamp/{resource}.json
```

All paths must end with `.json`.

## Common Endpoints

### Get Current User

```bash
GET /basecamp/my/profile.json
```

### List People

```bash
GET /basecamp/people.json
```

### List Projects

```bash
GET /basecamp/projects.json
```

### Get Project

```bash
GET /basecamp/projects/{project_id}.json
```

Returns project with `dock` array containing tool IDs.

### Create Project

```bash
POST /basecamp/projects.json
Content-Type: application/json

{
  "name": "Project Name",
  "description": "Description"
}
```

### Get Todoset

```bash
GET /basecamp/buckets/{project_id}/todosets/{todoset_id}.json
```

### List Todolists

```bash
GET /basecamp/buckets/{project_id}/todosets/{todoset_id}/todolists.json
```

### List Todos

```bash
GET /basecamp/buckets/{project_id}/todolists/{todolist_id}/todos.json
```

### Create Todo

```bash
POST /basecamp/buckets/{project_id}/todolists/{todolist_id}/todos.json
Content-Type: application/json

{
  "content": "Todo content",
  "due_on": "2026-02-15",
  "assignee_ids": [123]
}
```

### Complete Todo

```bash
POST /basecamp/buckets/{project_id}/todos/{todo_id}/completion.json
```

### Get Message Board

```bash
GET /basecamp/buckets/{project_id}/message_boards/{message_board_id}.json
```

### List Messages

```bash
GET /basecamp/buckets/{project_id}/message_boards/{message_board_id}/messages.json
```

### Get Schedule

```bash
GET /basecamp/buckets/{project_id}/schedules/{schedule_id}.json
```

### List Schedule Entries

```bash
GET /basecamp/buckets/{project_id}/schedules/{schedule_id}/entries.json
```

### Get Vault (Documents)

```bash
GET /basecamp/buckets/{project_id}/vaults/{vault_id}.json
```

### List Documents

```bash
GET /basecamp/buckets/{project_id}/vaults/{vault_id}/documents.json
```

### List Campfires

```bash
GET /basecamp/chats.json
```

### Trash Recording

```bash
PUT /basecamp/buckets/{project_id}/recordings/{recording_id}/status/trashed.json
```

## Key Concepts

- **Bucket**: Project content container (bucket_id = project_id)
- **Dock**: Per-project tool list with `id`, `name`, `enabled`
- **Recording**: Any content item (todos, messages, documents)

## Pagination

Uses `Link` header with `rel="next"`:

```
Link: <url>; rel="next"
X-Total-Count: 150
```

## Notes

- All paths must end with `.json`
- Gateway injects account ID automatically
- Uses Basecamp 4 API (bc3-api)
- Rate limit: ~50 requests per 10 seconds per IP
- Check `enabled: true` in dock before using tools

## Resources

- [Basecamp 4 API Documentation](https://github.com/basecamp/bc3-api)
- [API Endpoints](https://github.com/basecamp/bc3-api#endpoints)
