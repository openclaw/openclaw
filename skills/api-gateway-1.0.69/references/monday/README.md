# Monday.com Routing Reference

**App name:** `monday`
**Base URL proxied:** `api.monday.com`

## API Type

Monday.com uses a GraphQL API exclusively. All requests are POST requests to the `/v2` endpoint.

## API Path Pattern

```
/monday/v2
```

All operations use POST with a JSON body containing the `query` field.

## Common Operations

### Get Current User

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "{ me { id name email } }"
}
```

### List Workspaces

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "{ workspaces(limit: 20) { id name kind } }"
}
```

### List Boards

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "{ boards(limit: 20) { id name state board_kind workspace { id name } } }"
}
```

### Get Board with Items

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "{ boards(ids: [BOARD_ID]) { id name columns { id title type } groups { id title } items_page(limit: 50) { cursor items { id name state column_values { id text } } } } }"
}
```

### Create Board

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { create_board(board_name: \"New Board\", board_kind: public) { id name } }"
}
```

### Update Board

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { update_board(board_id: BOARD_ID, board_attribute: description, new_value: \"Description\") }"
}
```

### Delete Board

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { delete_board(board_id: BOARD_ID) { id } }"
}
```

### Get Items by ID

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "{ items(ids: [ITEM_ID]) { id name created_at state board { id name } group { id title } column_values { id text value } } }"
}
```

### Create Item

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { create_item(board_id: BOARD_ID, group_id: \"GROUP_ID\", item_name: \"New item\") { id name } }"
}
```

### Create Item with Column Values

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { create_item(board_id: BOARD_ID, group_id: \"GROUP_ID\", item_name: \"Task\", column_values: \"{\\\"status\\\": {\\\"label\\\": \\\"Working on it\\\"}}\") { id name } }"
}
```

### Update Item

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { change_simple_column_value(board_id: BOARD_ID, item_id: ITEM_ID, column_id: \"name\", value: \"Updated name\") { id name } }"
}
```

### Delete Item

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { delete_item(item_id: ITEM_ID) { id } }"
}
```

### Create Column

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { create_column(board_id: BOARD_ID, title: \"Status\", column_type: status) { id title type } }"
}
```

### Create Group

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "mutation { create_group(board_id: BOARD_ID, group_name: \"New Group\") { id title } }"
}
```

### List Users

```bash
POST /monday/v2
Content-Type: application/json

{
  "query": "{ users(limit: 50) { id name email } }"
}
```

## Pagination

Monday.com uses cursor-based pagination for items:

```bash
# First page
POST /monday/v2
{
  "query": "{ boards(ids: [BOARD_ID]) { items_page(limit: 50) { cursor items { id name } } } }"
}

# Next page
POST /monday/v2
{
  "query": "{ next_items_page(cursor: \"CURSOR_VALUE\", limit: 50) { cursor items { id name } } }"
}
```

## Notes

- Monday.com uses GraphQL exclusively (no REST API)
- Board IDs, item IDs, and user IDs are numeric strings
- Column IDs are alphanumeric (e.g., `color_mm09e48w`)
- Group IDs are alphanumeric (e.g., `group_mm0939df`, `topics`)
- Column values must be passed as JSON strings
- Board kinds: `public`, `private`, `share`
- Board states: `active`, `archived`, `deleted`, `all`
- Column types: `status`, `text`, `numbers`, `date`, `people`, `dropdown`, `checkbox`, `email`, `phone`, `link`, `timeline`, `tags`, `rating`
- Default limit is 25, maximum is 100
- Cursors are valid for 60 minutes

## Resources

- [Monday.com API Basics](https://developer.monday.com/api-reference/docs/basics)
- [GraphQL Overview](https://developer.monday.com/api-reference/docs/introduction-to-graphql)
- [Boards Reference](https://developer.monday.com/api-reference/reference/boards)
- [Items Reference](https://developer.monday.com/api-reference/reference/items)
- [Columns Reference](https://developer.monday.com/api-reference/reference/columns)
