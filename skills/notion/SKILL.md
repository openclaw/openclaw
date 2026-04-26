---
name: notion
description: Notion API for creating and managing pages, databases, and blocks.
homepage: https://developers.notion.com
metadata:
  {
    "openclaw":
      { "emoji": "📝", "requires": { "env": ["NOTION_API_KEY"] }, "primaryEnv": "NOTION_API_KEY" },
  }
---

# notion

Use the Notion API to create/read/update pages, data sources (databases), and blocks.

## Setup

1. Create an integration at https://notion.so/my-integrations
2. Copy the API key (starts with `ntn_` or `secret_`)
3. Store it:

```bash
mkdir -p ~/.config/notion
echo "ntn_your_key_here" > ~/.config/notion/api_key
```

4. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)

## API Basics

All requests need:

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
curl -X GET "https://api.notion.com/v1/..." \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json"
```

> **Note:** The `Notion-Version` header is required. This skill uses `2026-03-11` (latest). It builds on the 2025-09-03 "data sources" model (databases expose one or more data sources for queries and writes) and adds three renames: `archived` → `in_trash`, the `after` parameter on Append Block Children → a `position` object, and the `transcription` block type → `meeting_notes`.

## Common Operations

**Search for pages and data sources:**

```bash
curl -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"query": "page title"}'
```

**Get page:**

```bash
curl "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11"
```

**Get page content (blocks):**

```bash
curl "https://api.notion.com/v1/blocks/{page_id}/children" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11"
```

**Create a database:**

```bash
curl -X POST "https://api.notion.com/v1/databases" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"type": "page_id", "page_id": "PARENT_PAGE_ID"},
    "title": [{"text": {"content": "My Database"}}],
    "initial_data_source": {
      "properties": {
        "Name": {"title": {}},
        "Status": {"select": {"options": [{"name": "Todo"}, {"name": "Done"}]}}
      }
    }
  }'
```

The response is a [database object](https://developers.notion.com/reference/database) that includes a `data_sources` array. Use the returned `data_sources[0].id` value as the `data_source_id` when creating pages or querying the database contents. If the response is partial and `data_sources` is missing, retrieve the full object with `GET /v1/databases/{database_id}` to find the `data_source_id`.

**Create page in a data source:**

To add items to a database, target its `data_source_id`, not its `database_id`.

```bash
curl -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"type": "data_source_id", "data_source_id": "DATA_SOURCE_ID"},
    "properties": {
      "Name": {"title": [{"text": {"content": "New Item"}}]},
      "Status": {"select": {"name": "Todo"}}
    }
  }'
```

**Query a data source (database):**

```bash
curl -X POST "https://api.notion.com/v1/data_sources/{data_source_id}/query" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {"property": "Status", "select": {"equals": "Active"}},
    "sorts": [{"property": "Date", "direction": "descending"}]
  }'
```

**Update page properties:**

```bash
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
```

**Add blocks to page:**

```bash
curl -X PATCH "https://api.notion.com/v1/blocks/{page_id}/children" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{
    "children": [
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Hello"}}]}}
    ]
  }'
```

By default, blocks are appended to the end. To insert elsewhere, pass a `position` object (`{"type": "start"}`, `{"type": "end"}`, or `{"type": "after_block", "after_block": {"id": "BLOCK_ID"}}`). The flat `after` parameter from earlier API versions was replaced by `position` in 2026-03-11.

**Move a page to trash:**

```bash
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"in_trash": true}'
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

## Key Differences in 2026-03-11

This version layers three renames on top of the 2025-09-03 data-sources model.

**Renames in 2026-03-11:**

- `archived` → `in_trash` on pages, databases, blocks, and data sources (both request bodies and responses).
- The `after` parameter on Append Block Children → a `position` object with `type: "start" | "end" | "after_block"` (default `end`).
- Block type `transcription` → `meeting_notes`.

**Data sources model (carried over from 2025-09-03):**

- **Databases → Data Sources:** Use `/data_sources/` endpoints for queries and retrieval.
- **Database creation:** Use `POST /v1/databases` with `initial_data_source` to define the first schema.
- **Two IDs:** Each database has both a `database_id` and a `data_source_id`.
  - Use `data_source_id` when creating pages (`parent: {"type": "data_source_id", "data_source_id": "..."}`) and when querying (`POST /v1/data_sources/{id}/query`).
  - `database_id` is still accepted for backward compatibility in page parents, but `data_source_id` is the canonical approach.
- **Finding the data_source_id:** Call `GET /v1/databases/{database_id}` — the response includes a `data_sources` array with each child's `id` and `name`. Alternatively, search results return databases with their `data_sources` array.
- **Search results:** Databases return as `"object": "database"` with a `data_sources` array; capture the `data_source_id` you need for later writes and queries.
- **Parent in responses:** Pages show `parent.data_source_id` alongside `parent.database_id`.

## Notes

- Page/database IDs are UUIDs (with or without dashes).
- The API cannot set database view filters; that remains UI-only.
- Rate limit: ~3 requests/second average, with `429 rate_limited` responses using `Retry-After`.
- Append block children: up to 100 children per request, up to two levels of nesting in a single append request.
- Payload size limits: up to 1000 block elements and 500KB overall.
- Use `is_inline: true` when creating data sources to embed them in pages.
