---
name: mindsdb
description: Use for cross-database querying through MindsDB's Federated Query Engine when users ask for SQL/data lookup across connected databases.
metadata: { "openclaw": { "emoji": "🧠", "homepage": "https://mindsdb.com" } }
---

# MindsDB Federated Query

Use the `mindsdb` tool when the user needs SQL access to data and MindsDB is available.

## When to use

- Querying one or more connected databases through MindsDB
- Inspecting available databases/sources
- Turning literal SQL constants into named parameters

## Tool actions

- `query`: Execute SQL via MindsDB
- `list_databases`: List database sources visible to MindsDB
- `parametrize_constants`: Convert constants in SQL to parameter placeholders

## Guidance

- Prefer `query` with read-only SQL unless the user explicitly requests writes.
- Do not invent schema/table names. If unknown, inspect with `SHOW DATABASES` or metadata queries first.
- For user input in filters, prefer named parameters (`params`) instead of string interpolation.
- Keep responses concise and include key rows/columns rather than dumping huge outputs.

## Examples

Read query:

```json
{
  "action": "query",
  "query": "SELECT * FROM information_schema.databases"
}
```

Parameterized query:

```json
{
  "action": "query",
  "query": "SELECT NAME FROM information_schema.databases WHERE NAME = :db_name",
  "params": {
    "db_name": "mindsdb"
  }
}
```

List sources:

```json
{
  "action": "list_databases"
}
```
