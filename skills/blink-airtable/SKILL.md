---
name: blink-airtable
description: >
  Read, create, update, and search Airtable bases, tables, and records.
  Use when asked to manage data in Airtable, track tasks, update CRM records,
  or query structured data. Requires a linked Airtable connection.
metadata:
  { "blink": { "requires_env": ["BLINK_API_KEY", "BLINK_AGENT_ID"], "connector": "airtable" } }
---

# Blink Airtable

Access the user's Airtable bases and records. Provider key: `airtable`.

## List all bases
```bash
bash scripts/call.sh airtable /meta/bases GET
```

## Get base schema (tables + fields)
```bash
bash scripts/call.sh airtable /meta/bases/BASE_ID/tables GET
```

## List records in a table
```bash
bash scripts/call.sh airtable /BASE_ID/TABLE_NAME_OR_ID GET \
  '{"maxRecords": 50, "view": "Grid view"}'
```

## Filter records
```bash
bash scripts/call.sh airtable /BASE_ID/TABLE_NAME_OR_ID GET \
  '{"filterByFormula": "AND({Status}=\"In Progress\",{Assignee}=\"Alice\")", "maxRecords": 20}'
```

## Get a single record
```bash
bash scripts/call.sh airtable /BASE_ID/TABLE_NAME/RECORD_ID GET
```

## Create records
```bash
bash scripts/call.sh airtable /BASE_ID/TABLE_NAME POST '{
  "records": [{
    "fields": {
      "Name": "New Task",
      "Status": "To Do",
      "Due Date": "2026-04-01",
      "Assignee": "Alice"
    }
  }]
}'
```

## Update a record
```bash
bash scripts/call.sh airtable /BASE_ID/TABLE_NAME/RECORD_ID PATCH '{
  "fields": {
    "Status": "Done",
    "Completed Date": "2026-03-15"
  }
}'
```

## Delete a record
```bash
bash scripts/call.sh airtable /BASE_ID/TABLE_NAME/RECORD_ID DELETE '{}'
```

## Common use cases
- "Show me all open tasks in the project tracker" → list records with filter
- "Add a new lead to the CRM" → create record in leads table
- "Mark task X as complete" → update record status field
- "What bases do I have?" → list bases
- "Find all contacts from Acme Corp" → filter records by company field
