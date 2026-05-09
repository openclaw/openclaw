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
3. Configure the skill with `NOTION_API_KEY`. OpenClaw injects `skills.entries.notion.apiKey` into `process.env.NOTION_API_KEY` for the agent turn because this skill declares `metadata.openclaw.primaryEnv`.

```json5
{
  skills: {
    entries: {
      notion: {
        enabled: true,
        apiKey: "ntn_your_key_here",
      },
    },
  },
}
```

4. Share target pages/databases with your integration (click "..." → "Connect to" → your integration name)

## API Basics

All requests need the `Authorization`, `Notion-Version`, and usually `Content-Type` headers. Use `NOTION_API_KEY`; do not create a shell-local alias such as `NOTION_KEY=$(cat ...)`.

Strict exec allowlist note: avoid examples shaped like `NOTION_KEY=...; curl ...`, command substitution, shell chaining, and line continuations. In `security=allowlist` with `ask=off`, those forms can be denied as an allowlist miss even when the underlying `curl` binary is allowlisted. Prefer a direct executable invocation with secrets already supplied in the environment, or a small file-backed helper run through an allowlisted interpreter.

> **Note:** The `Notion-Version` header is required. This skill uses `2025-09-03` (latest). In this version, databases are called "data sources" in the API.

### Allowlist-friendly helper

For strict allowlist setups, create a helper file once and run it directly with an allowlisted `python3`. The helper reads `NOTION_API_KEY` from the environment and reads request bodies from files, so command lines do not need shell variable assignment, command substitution, semicolon chaining, or continuation characters.

Save as `notion_request.py`:

```python
#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request

if len(sys.argv) not in (3, 4):
    raise SystemExit("usage: notion_request.py METHOD /v1/path [body.json]")

method, api_path = sys.argv[1], sys.argv[2]
body_path = sys.argv[3] if len(sys.argv) == 4 else None
api_key = os.environ["NOTION_API_KEY"]
data = None
if body_path:
    with open(body_path, "rb") as body_file:
        data = body_file.read()

request = urllib.request.Request(
    f"https://api.notion.com{api_path}",
    data=data,
    method=method.upper(),
    headers={
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
    },
)

try:
    with urllib.request.urlopen(request, timeout=30) as response:
        print(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    print(error.read().decode("utf-8"), file=sys.stderr)
    raise SystemExit(error.code)
```

## Common Operations

**Search for pages and data sources:**

```json
{ "query": "page title" }
```

Save the JSON as `search.json`, then run:

```bash
python3 notion_request.py POST /v1/search search.json
```

**Get page:**

```bash
python3 notion_request.py GET /v1/pages/{page_id}
```

**Get page content (blocks):**

```bash
python3 notion_request.py GET /v1/blocks/{page_id}/children
```

**Create page in a data source:**

```json
{
  "parent": { "database_id": "xxx" },
  "properties": {
    "Name": { "title": [{ "text": { "content": "New Item" } }] },
    "Status": { "select": { "name": "Todo" } }
  }
}
```

Save the JSON as `create-page.json`, then run:

```bash
python3 notion_request.py POST /v1/pages create-page.json
```

**Query a data source (database):**

```json
{
  "filter": { "property": "Status", "select": { "equals": "Active" } },
  "sorts": [{ "property": "Date", "direction": "descending" }]
}
```

Save the JSON as `query-data-source.json`, then run:

```bash
python3 notion_request.py POST /v1/data_sources/{data_source_id}/query query-data-source.json
```

**Create a data source (database):**

```json
{
  "parent": { "page_id": "xxx" },
  "title": [{ "text": { "content": "My Database" } }],
  "properties": {
    "Name": { "title": {} },
    "Status": { "select": { "options": [{ "name": "Todo" }, { "name": "Done" }] } },
    "Date": { "date": {} }
  }
}
```

Save the JSON as `create-data-source.json`, then run:

```bash
python3 notion_request.py POST /v1/data_sources create-data-source.json
```

**Update page properties:**

```json
{ "properties": { "Status": { "select": { "name": "Done" } } } }
```

Save the JSON as `update-page.json`, then run:

```bash
python3 notion_request.py PATCH /v1/pages/{page_id} update-page.json
```

**Add blocks to page:**

```json
{
  "children": [
    {
      "object": "block",
      "type": "paragraph",
      "paragraph": { "rich_text": [{ "text": { "content": "Hello" } }] }
    }
  ]
}
```

Save the JSON as `append-blocks.json`, then run:

```bash
python3 notion_request.py PATCH /v1/blocks/{page_id}/children append-blocks.json
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
- Rate limit: ~3 requests/second average, with `429 rate_limited` responses using `Retry-After`
- Append block children: up to 100 children per request, up to two levels of nesting in a single append request
- Payload size limits: up to 1000 block elements and 500KB overall
- Use `is_inline: true` when creating data sources to embed them in pages
