---
name: notion
description: Notion API for creating and managing pages, databases, and blocks.
homepage: https://developers.notion.com
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "env": ["NOTION_TOKEN"] }, "primaryEnv": "NOTION_TOKEN" },
  }
---

# notion

Use the Notion API to create/read/update pages, database containers, data sources, and blocks.

## Setup

1. Create an integration at https://notion.so/my-integrations
2. Copy the API key (starts with `ntn_` or `secret_`)
3. Export it for OpenClaw:

```bash
export NOTION_TOKEN="ntn_your_key_here"
```

4. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)

## API Basics

All requests need:

```bash
curl -X GET "https://api.notion.com/v1/..." \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json"
```

> **Note:** The `Notion-Version` header is required. This skill uses `2026-03-11` (latest). The big database/data-source split happened in `2025-09-03`; `2026-03-11` mainly switches `archived` to `in_trash`, `after` to `position`, and `transcription` to `meeting_notes`.

## OpenClaw Plugin Tools

The OpenClaw Notion plugin provides 20 tools for working with Notion. Use these tools instead of direct API calls.

### Tool List

**Search & Fetch:**
- `notion_search` - Search pages and data sources
- `notion_fetch` - Fetch a page or data source by ID
- `notion_query_data_source` - Query a data source with filters and sorting

**Page Operations:**
- `notion_create_page` - Create a page in a data source
- `notion_update_page` - Update page properties or content
- `notion_delete_page` - Move page to trash

**Data Source Operations:**
- `notion_create_data_source` - Create a data source in a database container
- `notion_update_data_source` - Update data source properties

**Block Operations:**
- `notion_get_block` - Get a block by ID
- `notion_get_block_children` - Get block children with pagination
- `notion_append_block_children` - Add blocks to a page/block
- `notion_update_block` - Update block content
- `notion_delete_block` - Delete/archive a block

**Database Operations:**
- `notion_get_database` - Get database container metadata

**User Operations:**
- `notion_get_user` - Get user by ID
- `notion_list_users` - List all workspace users

**Comment Operations:**
- `notion_get_comments` - Get comments for a block/page
- `notion_create_comment` - Create a comment
- `notion_update_comment` - Update a comment

**Advanced Search:**
- `notion_advanced_search` - Advanced search with filters, sorting, pagination

### Tool Usage Examples

**Create a database container with initial data source:**

Use `notion_create_data_source` with a page parent:
```
notion_create_data_source(
  parentId: "page_id_here",
  title: "My Database",
  properties: {
    "Name": { title: {} },
    "Status": { select: { options: [{ name: "Todo" }, { name: "Done" }] } }
  }
)
```

**Create a row in a data source:**

Use `notion_create_page` with `data_source_id` parent:
```
notion_create_page(
  parentId: "data_source_id_here",
  properties: {
    "Name": { title: [{ text: { content: "New Item" } }] },
    "Status": { select: { name: "Todo" } }
  }
)
```

**Query a data source:**

Use `notion_query_data_source` with filters:
```
notion_query_data_source(
  dataSourceId: "data_source_id_here",
  filter: { property: "Status", select: { equals: "Active" } },
  sorts: [{ property: "Date", direction: "descending" }]
)
```

**Add blocks to a page:**

Use `notion_append_block_children`:
```
notion_append_block_children(
  blockId: "page_id_here",
  children: [
    { type: "paragraph", paragraph: { rich_text: [{ text: { content: "Hello" } }] } }
  ],
  position: { before: "block_id" }  // Optional: position parameter (2026-03-11)
)
```

**Delete a page (move to trash):**

Use `notion_delete_page`:
```
notion_delete_page(pageId: "page_id_here")
```

**Delete a data source (move to trash):**

Use `notion_update_data_source` with `inTrash: true`:
```
notion_update_data_source(
  dataSourceId: "data_source_id_here",
  inTrash: true
)
```

> **Note:** In API 2026-03-11, deletion uses `in_trash: true` instead of the old `archived: true`. The old method returns 404 "Object not found".

### Important Notes

- **Parent types:** Use `type: "page"` for page parents and `type: "data_source"` for data source parents
- **Data source ID:** When creating rows, use the `data_source_id` (not the `database_id`)
- **Finding data source ID:** Use `notion_fetch` on the database container to get its `data_sources` array
- **Position parameter:** `notion_append_block_children` supports optional `position` parameter (replaces `after` in 2026-03-11)
- **Trash:** `notion_delete_page` moves pages to trash (`in_trash: true`)

## Common Operations

**Search for pages and data sources:**

```bash
curl -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"query": "page title"}'
```

**Get page:**

```bash
curl "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11"
```

**Get page content (blocks):**

```bash
curl "https://api.notion.com/v1/blocks/{page_id}/children" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11"
```

**Create page in a data source:**

```bash
curl -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"data_source_id": "xxx"},
    "properties": {
      "Name": {"title": [{"text": {"content": "New Item"}}]},
      "Status": {"select": {"name": "Todo"}}
    }
  }'
```

**Create a database container with its initial data source:**

```bash
curl -X POST "https://api.notion.com/v1/databases" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"type": "page_id", "page_id": "xxx"},
    "title": [{"text": {"content": "My Database"}}],
    "initial_data_source": {
      "properties": {
        "Name": {"title": {}},
        "Status": {"select": {"options": [{"name": "Todo"}, {"name": "Done"}]}}
      }
    }
  }'
```

**Query a data source (database):**

```bash
curl -X POST "https://api.notion.com/v1/data_sources/{data_source_id}/query" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {"property": "Status", "select": {"equals": "Active"}},
    "sorts": [{"property": "Date", "direction": "descending"}]
  }'
```

**Create a data source (database):**

```bash
curl -X POST "https://api.notion.com/v1/data_sources" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "xxx"},
    "title": [{"text": {"content": "My Database"}}],
    "properties": {
      "Name": {"title": {}},
      "Status": {"select": {"options": [{"name": "Todo"}, {"name": "Done"}]}},
      "Date": {"date": {}}
    }
  }'
```

**Update page properties:**

```bash
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
```

**Add blocks to page:**

```bash
curl -X PATCH "https://api.notion.com/v1/blocks/{page_id}/children" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "children": [
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Hello"}}]}}
    ]
  }'
```

## User Operations

**Get user information:**

```bash
curl "https://api.notion.com/v1/users/{user_id}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11"
```

**List all users in workspace:**

```bash
curl "https://api.notion.com/v1/users" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11"
```

## Comment Operations

**Get comments for a block or page:**

```bash
curl "https://api.notion.com/v1/comments?block_id={block_id}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11"
```

**Create a comment:**

```bash
curl -X POST "https://api.notion.com/v1/comments" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"page_id": "xxx"},
    "rich_text": [{"type": "text", "text": {"content": "My comment"}}]
  }'
```

**Update a comment:**

```bash
curl -X PATCH "https://api.notion.com/v1/comments/{comment_id}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "rich_text": [{"type": "text", "text": {"content": "Updated comment"}}]
  }'
```

## Advanced Search

**Advanced search with filters and sorting:**

```bash
curl -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "search term",
    "filter": {
      "property": "object",
      "value": "page"
    },
    "sort": {
      "direction": "descending",
      "timestamp": "last_edited_time"
    },
    "page_size": 50
  }'
```

## Property Types

Common property formats for database items:

- **Title:** `{"title": [{"text": {"content": "..."}}]}`
- **Rich text:** `{"rich_text": [{"text": {"content": "..."}}]}`
- **Select:** `{"select": {"name": "Option"}}`
- **Multi-select:** `{"multi_select": [{"name": "A"}, {"name": "B"}]}`
- **Date:** `{"date": {"start": "2024-01-15", "end": "2024-01-16"}}`
- **Checkbox:** `{"checkbox": true}`
- **Number:** `{"number": 42}`
- **URL:** `{"url": "https://..."}`
- **Email:** `{"email": "a@b.com"}`
- **Relation:** `{"relation": [{"id": "page_id"}]}`

## Version Notes

- **2025-09-03:** Databases split into database containers plus child data sources.
- **Page creation:** Use `parent.data_source_id` when creating rows in a table.
- **Data source operations:** Use `/data_sources/*` or `notion.dataSources.*` for retrieve/query/create/update.
- **Database container operations:** Use `/databases/*` or `notion.databases.*` to create or inspect the container and discover its `data_sources`.
- **2026-03-11:** Replace `archived` with `in_trash`, replace append-block `after` with `position`, and replace `transcription` blocks with `meeting_notes`.
- **Finding the data source ID:** Retrieve the database container and read `data_sources[]`, or copy the data source ID directly from Notion.

## SDK Integration

The OpenClaw Notion plugin uses the official `@notionhq/client` SDK (`v5.19.0` at the time of writing) internally. The SDK handles:

- **Authentication:** Bearer token via `NOTION_TOKEN` env var
- **API versioning:** `Notion-Version: 2026-03-11` header automatically applied
- **Retry logic:** Built-in retries for `429 rate_limited` and server errors (5xx)
- **Error handling:** SDK-native error types (`isNotionClientError`, `APIResponseError`) mapped to `NotionApiError`

## Notes

- Page/database IDs are UUIDs (with or without dashes)
- The API cannot set database view filters — that's UI-only
- Rate limit: ~3 requests/second average; the SDK auto-retries on `429` responses
- Append block children: up to 100 children per request, up to two levels of nesting in a single append request
- Payload size limits: up to 1000 block elements and 500KB overall
- Use `is_inline: true` when creating data sources to embed them in pages
