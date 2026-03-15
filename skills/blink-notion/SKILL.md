---
name: blink-notion
description: >
  Read, search, create, and update content in the user's linked Notion workspace.
  Use when asked to check notes, create pages, query databases, update tasks,
  or search for information in Notion. Requires a linked Notion connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "notion" } }
---

# Blink Notion

Access the user's linked Notion workspace. Before using, check that Notion is connected:
```bash
bash scripts/status.sh
```

## Search everything
```bash
bash scripts/call.sh notion /search POST '{"query": "meeting notes", "filter": {"property": "object", "value": "page"}}'
```

## List all databases
```bash
bash scripts/call.sh notion /search POST '{"filter": {"property": "object", "value": "database"}}'
```

## Query a database (with filters)
```bash
bash scripts/call.sh notion /databases/DATABASE_ID/query POST '{
  "filter": {"property": "Status", "select": {"equals": "In Progress"}},
  "sorts": [{"property": "Due Date", "direction": "ascending"}]
}'
```

## Get a page's content
```bash
bash scripts/call.sh notion /pages/PAGE_ID GET
bash scripts/call.sh notion /blocks/PAGE_ID/children GET
```

## Create a new page
```bash
bash scripts/call.sh notion /pages POST '{
  "parent": {"database_id": "DATABASE_ID"},
  "properties": {
    "Name": {"title": [{"text": {"content": "New Task"}}]},
    "Status": {"select": {"name": "To Do"}}
  }
}'
```

## Update a page property
```bash
bash scripts/call.sh notion /pages/PAGE_ID PATCH '{
  "properties": {
    "Status": {"select": {"name": "Done"}}
  }
}'
```

## Add content to a page
```bash
bash scripts/call.sh notion /blocks/PAGE_ID/children PATCH '{
  "children": [{"object": "block", "type": "paragraph",
    "paragraph": {"rich_text": [{"type": "text", "text": {"content": "Added by agent"}}]}}]
}'
```

## Common use cases
- "What tasks are in my Notion todo database?" → query the tasks DB
- "Create a meeting notes page for today" → create page in meeting notes DB
- "Mark task X as done" → update page property
- "What did I write about project Y?" → search all content
- "Add a note to my daily journal" → append block to today's page
