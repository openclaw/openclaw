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

All requests use Python's built-in `urllib` (stdlib, no external deps). This is allowlist-friendly — avoids shell variable chaining patterns that can fail under `security=allowlist` exec policies.

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
```

> **Note:** The `Notion-Version` header is required. This skill uses `2025-09-03` (latest). In this version, databases are called "data sources" in the API.

> **Allowlist environments:** If `python3` is not yet allowlisted, add it: `openclaw config add plugins.exec.allow python3`

## Common Operations

**Search for pages and data sources:**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
payload = json.dumps({'query': 'page title'}).encode()
req = urllib.request.Request(
    'https://api.notion.com/v1/search',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json'},
    data=payload
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Get page:**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
page_id = 'PAGE_ID_HERE'
req = urllib.request.Request(
    f'https://api.notion.com/v1/pages/{page_id}',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03'}
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Get page content (blocks):**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
page_id = 'PAGE_ID_HERE'
req = urllib.request.Request(
    f'https://api.notion.com/v1/blocks/{page_id}/children',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03'}
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Create page in a data source:**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
payload = json.dumps({
    'parent': {'database_id': 'DATABASE_ID_HERE'},
    'properties': {
        'Name': {'title': [{'text': {'content': 'New Item'}}]},
        'Status': {'select': {'name': 'Todo'}}
    }
}).encode()
req = urllib.request.Request(
    'https://api.notion.com/v1/pages',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json'},
    data=payload
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Query a data source (database):**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
payload = json.dumps({
    'filter': {'property': 'Status', 'select': {'equals': 'Active'}},
    'sorts': [{'property': 'Date', 'direction': 'descending'}]
}).encode()
req = urllib.request.Request(
    'https://api.notion.com/v1/data_sources/DATA_SOURCE_ID_HERE/query',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json'},
    data=payload
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Create a data source (database):**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
payload = json.dumps({
    'parent': {'page_id': 'PAGE_ID_HERE'},
    'title': [{'text': {'content': 'My Database'}}],
    'properties': {
        'Name': {'title': {}},
        'Status': {'select': {'options': [{'name': 'Todo'}, {'name': 'Done'}]}},
        'Date': {'date': {}}
    }
}).encode()
req = urllib.request.Request(
    'https://api.notion.com/v1/data_sources',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json'},
    data=payload
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Update page properties:**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
payload = json.dumps({'properties': {'Status': {'select': {'name': 'Done'}}}}).encode()
req = urllib.request.Request(
    'https://api.notion.com/v1/pages/PAGE_ID_HERE',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json'},
    data=payload,
    method='PATCH'
)
print(urllib.request.urlopen(req).read().decode())
"
```

**Add blocks to page:**

```bash
NOTION_KEY=$(cat ~/.config/notion/api_key)
python3 -c "
import json, os, urllib.request
key = os.environ.get('NOTION_KEY','')
payload = json.dumps({
    'children': [
        {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': [{'text': {'content': 'Hello'}}]}}
    ]
}).encode()
req = urllib.request.Request(
    'https://api.notion.com/v1/blocks/PAGE_ID_HERE/children',
    headers={'Authorization': f'Bearer {key}', 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json'},
    data=payload,
    method='PATCH'
)
print(urllib.request.urlopen(req).read().decode())
"
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

## Key Differences in 2025-09-03

- **Databases → Data Sources:** Use `/data_sources/` endpoints for queries and retrieval
- **Two IDs:** Each database now has both a `database_id` and a `data_source_id`
  - Use `database_id` when creating pages (`parent: {"database_id": "..."}`)
  - Use `data_source_id` when querying (`POST /v1/data_sources/{id}/query`)
- **Search results:** Databases return as `"object": "data_source"` with their `data_source_id`
- **Parent in responses:** Pages show `parent.data_source_id` alongside `parent.database_id`
- **Finding the data_source_id:** Search for the database, or call `GET /v1/data_sources/{data_source_id}`

## Notes

- Page/database IDs are UUIDs (with or without dashes)
- The API cannot set database view filters — that's UI-only
- Rate limit: ~3 requests/second average
- Use `is_inline: true` when creating data sources to embed them in pages
- **Allowlist environments:** This skill uses `python3 -c "..."` with `urllib` (stdlib) to avoid shell variable chaining issues that can trigger `allowlist miss` errors. If `python3` is not allowlisted, add it to your `plugins.exec.allow` list in `openclaw.json`.
