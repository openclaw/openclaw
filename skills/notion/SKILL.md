---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: notion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Notion API for creating and managing pages, databases, and blocks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://developers.notion.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { "emoji": "📝", "requires": { "env": ["NOTION_API_KEY"] }, "primaryEnv": "NOTION_API_KEY" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# notion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the Notion API to create/read/update pages, data sources (databases), and blocks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create an integration at https://notion.so/my-integrations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Copy the API key (starts with `ntn_` or `secret_`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Store it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.config/notion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo "ntn_your_key_here" > ~/.config/notion/api_key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## API Basics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All requests need:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
NOTION_KEY=$(cat ~/.config/notion/api_key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X GET "https://api.notion.com/v1/..." \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Note:** The `Notion-Version` header is required. This skill uses `2025-09-03` (latest). In this version, databases are called "data sources" in the API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common Operations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Search for pages and data sources:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST "https://api.notion.com/v1/search" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"query": "page title"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Get page:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl "https://api.notion.com/v1/pages/{page_id}" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Get page content (blocks):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl "https://api.notion.com/v1/blocks/{page_id}/children" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Create page in a data source:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST "https://api.notion.com/v1/pages" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "parent": {"database_id": "xxx"},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "properties": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Name": {"title": [{"text": {"content": "New Item"}}]},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Status": {"select": {"name": "Todo"}}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Query a data source (database):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST "https://api.notion.com/v1/data_sources/{data_source_id}/query" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "filter": {"property": "Status", "select": {"equals": "Active"}},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "sorts": [{"property": "Date", "direction": "descending"}]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Create a data source (database):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST "https://api.notion.com/v1/data_sources" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "parent": {"page_id": "xxx"},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "title": [{"text": {"content": "My Database"}}],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "properties": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Name": {"title": {}},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Status": {"select": {"options": [{"name": "Todo"}, {"name": "Done"}]}},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "Date": {"date": {}}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Update page properties:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Add blocks to page:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X PATCH "https://api.notion.com/v1/blocks/{page_id}/children" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Authorization: Bearer $NOTION_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Notion-Version: 2025-09-03" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Content-Type: application/json" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "children": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Hello"}}]}}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Property Types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common property formats for database items:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Title:** `{"title": [{"text": {"content": "..."}}]}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Rich text:** `{"rich_text": [{"text": {"content": "..."}}]}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Select:** `{"select": {"name": "Option"}}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-select:** `{"multi_select": [{"name": "A"}, {"name": "B"}]}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Date:** `{"date": {"start": "2024-01-15", "end": "2024-01-16"}}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Checkbox:** `{"checkbox": true}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Number:** `{"number": 42}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **URL:** `{"url": "https://..."}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Email:** `{"email": "a@b.com"}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Relation:** `{"relation": [{"id": "page_id"}]}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key Differences in 2025-09-03（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Databases → Data Sources:** Use `/data_sources/` endpoints for queries and retrieval（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Two IDs:** Each database now has both a `database_id` and a `data_source_id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Use `database_id` when creating pages (`parent: {"database_id": "..."}`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Use `data_source_id` when querying (`POST /v1/data_sources/{id}/query`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Search results:** Databases return as `"object": "data_source"` with their `data_source_id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Parent in responses:** Pages show `parent.data_source_id` alongside `parent.database_id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Finding the data_source_id:** Search for the database, or call `GET /v1/data_sources/{data_source_id}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Page/database IDs are UUIDs (with or without dashes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The API cannot set database view filters — that's UI-only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rate limit: ~3 requests/second average（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `is_inline: true` when creating data sources to embed them in pages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
