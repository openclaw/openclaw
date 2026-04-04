# Notion Routing Reference

**App name:** `notion`
**Base URL proxied:** `api.notion.com`

## Required Headers

All Notion API requests require:

```
Notion-Version: 2025-09-03
```

## API Path Pattern

```
/notion/v1/{endpoint}
```

## Key Concept: Databases vs Data Sources

In API version 2025-09-03, databases and data sources are separate concepts:

| Concept         | Description                                   | Use For                                        |
| --------------- | --------------------------------------------- | ---------------------------------------------- |
| **Database**    | Container that can hold multiple data sources | Creating databases, getting data_source IDs    |
| **Data Source** | Schema and data within a database             | Querying, updating schema, updating properties |

Most existing databases have one data source. Use `GET /databases/{id}` to get the `data_source_id`, then use `/data_sources/` endpoints for all operations.

## Common Endpoints

### Search

Search for pages:

```bash
POST /notion/v1/search
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "query": "meeting notes",
  "filter": {"property": "object", "value": "page"}
}
```

Search for data sources:

```bash
POST /notion/v1/search
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "filter": {"property": "object", "value": "data_source"}
}
```

With pagination:

```bash
POST /notion/v1/search
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "page_size": 10,
  "start_cursor": "CURSOR_FROM_PREVIOUS_RESPONSE"
}
```

### Data Sources

Use data source endpoints for querying, getting schema, and updates.

#### Get Data Source

```bash
GET /notion/v1/data_sources/{dataSourceId}
Notion-Version: 2025-09-03
```

Returns full schema with `properties` field.

#### Query Data Source

```bash
POST /notion/v1/data_sources/{dataSourceId}/query
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "filter": {
    "property": "Status",
    "select": {"equals": "Active"}
  },
  "sorts": [
    {"property": "Created", "direction": "descending"}
  ],
  "page_size": 100
}
```

#### Update Data Source (title, schema, properties)

```bash
PATCH /notion/v1/data_sources/{dataSourceId}
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "title": [{"type": "text", "text": {"content": "Updated Title"}}],
  "properties": {
    "NewColumn": {"rich_text": {}}
  }
}
```

### Databases

Database endpoints are only needed for **creating** databases and **discovering** data source IDs.

#### Get Database (to find data_source_id)

```bash
GET /notion/v1/databases/{databaseId}
Notion-Version: 2025-09-03
```

Response includes `data_sources` array:

```json
{
  "id": "database-id",
  "object": "database",
  "data_sources": [{ "id": "data-source-id", "name": "Database Name" }]
}
```

**Note:** This endpoint returns `properties: null`. Use `GET /data_sources/{id}` to get the schema.

#### Create Database

```bash
POST /notion/v1/databases
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "parent": {"type": "page_id", "page_id": "PARENT_PAGE_ID"},
  "title": [{"type": "text", "text": {"content": "New Database"}}],
  "properties": {
    "Name": {"title": {}},
    "Status": {"select": {"options": [{"name": "Active"}, {"name": "Done"}]}}
  }
}
```

**Important:** Cannot create databases via `/data_sources` endpoint.

### Pages

#### Get Page

```bash
GET /notion/v1/pages/{pageId}
Notion-Version: 2025-09-03
```

#### Create Page in Data Source

Use `data_source_id` (not `database_id`) as parent:

```bash
POST /notion/v1/pages
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "parent": {"data_source_id": "DATA_SOURCE_ID"},
  "properties": {
    "Name": {"title": [{"text": {"content": "New Page"}}]},
    "Status": {"select": {"name": "Active"}}
  }
}
```

#### Create Child Page (under another page)

```bash
POST /notion/v1/pages
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "parent": {"page_id": "PARENT_PAGE_ID"},
  "properties": {
    "title": {"title": [{"text": {"content": "Child Page"}}]}
  }
}
```

#### Update Page Properties

```bash
PATCH /notion/v1/pages/{pageId}
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "properties": {
    "Status": {"select": {"name": "Done"}}
  }
}
```

#### Archive Page

```bash
PATCH /notion/v1/pages/{pageId}
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "archived": true
}
```

### Blocks

#### Get Block

```bash
GET /notion/v1/blocks/{blockId}
Notion-Version: 2025-09-03
```

#### Get Block Children

```bash
GET /notion/v1/blocks/{blockId}/children
Notion-Version: 2025-09-03
```

#### Append Block Children

```bash
PATCH /notion/v1/blocks/{blockId}/children
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": {
        "rich_text": [{"type": "text", "text": {"content": "New paragraph"}}]
      }
    },
    {
      "object": "block",
      "type": "heading_2",
      "heading_2": {
        "rich_text": [{"type": "text", "text": {"content": "Heading"}}]
      }
    }
  ]
}
```

#### Update Block

```bash
PATCH /notion/v1/blocks/{blockId}
Content-Type: application/json
Notion-Version: 2025-09-03

{
  "paragraph": {
    "rich_text": [{"text": {"content": "Updated text"}}]
  }
}
```

#### Delete Block

```bash
DELETE /notion/v1/blocks/{blockId}
Notion-Version: 2025-09-03
```

### Users

#### List Users

```bash
GET /notion/v1/users
Notion-Version: 2025-09-03
```

#### Get User by ID

```bash
GET /notion/v1/users/{userId}
Notion-Version: 2025-09-03
```

#### Get Current User (Bot)

```bash
GET /notion/v1/users/me
Notion-Version: 2025-09-03
```

## Filter Operators

- `equals`, `does_not_equal`
- `contains`, `does_not_contain`
- `starts_with`, `ends_with`
- `is_empty`, `is_not_empty`
- `greater_than`, `less_than`, `greater_than_or_equal_to`, `less_than_or_equal_to`

## Block Types

Common block types for appending:

- `paragraph` - Text paragraph
- `heading_1`, `heading_2`, `heading_3` - Headings
- `bulleted_list_item`, `numbered_list_item` - List items
- `to_do` - Checkbox item
- `code` - Code block
- `quote` - Quote block
- `divider` - Horizontal divider

## Migration from Older API Versions

| Old (2022-06-28)                   | New (2025-09-03)                      |
| ---------------------------------- | ------------------------------------- |
| `POST /databases/{id}/query`       | `POST /data_sources/{id}/query`       |
| `GET /databases/{id}` for schema   | `GET /data_sources/{id}` for schema   |
| `PATCH /databases/{id}` for schema | `PATCH /data_sources/{id}` for schema |
| Parent: `{"database_id": "..."}`   | Parent: `{"data_source_id": "..."}`   |
| Search filter: `"database"`        | Search filter: `"data_source"`        |

## Notes

- Use `GET /databases/{id}` to discover `data_source_id`, then use `/data_sources/` for all operations
- Creating databases still requires `POST /databases` endpoint
- Parent objects for create database require `type` field: `{"type": "page_id", "page_id": "..."}`
- All IDs are UUIDs (with or without hyphens)
- Delete blocks returns the block with `archived: true`

## Resources

- [API Introduction](https://developers.notion.com/reference/intro)
- [Search](https://developers.notion.com/reference/post-search.md)
- [Query Database](https://developers.notion.com/reference/post-database-query.md)
- [Get Database](https://developers.notion.com/reference/retrieve-a-database.md)
- [Create Database](https://developers.notion.com/reference/create-a-database.md)
- [Get Page](https://developers.notion.com/reference/retrieve-a-page.md)
- [Create Page](https://developers.notion.com/reference/post-page.md)
- [Update Page](https://developers.notion.com/reference/patch-page.md)
- [Get Block Children](https://developers.notion.com/reference/get-block-children.md)
- [Append Block Children](https://developers.notion.com/reference/patch-block-children.md)
- [List Users](https://developers.notion.com/reference/get-users.md)
- [Filter Reference](https://developers.notion.com/reference/post-database-query-filter.md)
- [LLM Reference](https://developers.notion.com/llms.txt)
- [Version Reference](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03)
