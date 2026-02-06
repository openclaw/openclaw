---
name: text2sql
description: Natural-language queries over a read-only PostgreSQL database. Use when the user asks to get data from the database, pull pipeline/table data, run a query, or export to CSV. Requires DATABASE_URL (read-only user recommended).
metadata: { "openclaw": { "emoji": "🗄️", "requires": { "env": ["DATABASE_URL"] } } }
---

# Text2SQL (PostgreSQL read-only)

## Overview

Answer natural-language questions about data in a PostgreSQL database by turning them into read-only SQL. Only **SELECT** is allowed; any request to change data must be declined.

## When to use

- User asks for data from "the database", "Postgres", "our DB", "pipeline data", "table data", "run a query", "export to CSV", or similar.
- User asks for table names (e.g. "what tables are there", "nama tabel ada apa aja", "list tables").
- Requires `DATABASE_URL`. A read-only database user is strongly recommended — the built-in SQL validator provides defense-in-depth but should not be the sole safeguard.

## Critical: use the script, do not search the workspace

When the user asks for **table names** or **data from the database**, you **must** run the script below. Do **not** search the workspace with grep/rg or list files; the database is not in the workspace. Run from the current workspace (it must contain `skills/text2sql/`; typically the OpenClaw repo). `DATABASE_URL` is already in the environment from config.

## Credentials

Set `DATABASE_URL` in the environment, or store it in `~/.openclaw/openclaw.json` (same as other skills):

```json5
{
  skills: {
    entries: {
      text2sql: {
        enabled: true,
        env: {
          DATABASE_URL: "postgresql://user:password@host:5432/dbname",
        },
      },
    },
  },
}
```

Replace with your host, port, database, username, and password. Do not commit this file; it lives in your home directory.

## Read-only rule

**Only reads are allowed.** If the user asks to INSERT, UPDATE, DELETE, or otherwise change data, decline and explain that this skill is read-only. Do not attempt to run any non-SELECT statement.

## Workflow

1. **Unclear table:** If the request does not identify the table (e.g. "latest pipeline data"), run the script with `list_tables`, then infer from names or **ask the user to confirm** which table to use.
2. **Before building a query:** Run the script with `schema --table <T>` and `sample --table <T>` to get column names and one sample row so you can build correct SQL.
3. **Build and run:** Compose a single `SELECT`; run the script with `query --sql "..." [--limit N]` (max 1000 rows).
4. **Output:** Return raw CSV (with a row limit) or use the result as context and write a short analysis in natural language.

## How to run the script

Run from the workspace root (current directory). `DATABASE_URL` is injected from config; do not prefix it unless testing in CLI.

```bash
# List tables (use this when user asks "what tables" / "nama tabel ada apa")
node --import tsx skills/text2sql/scripts/query.ts list_tables

# Schema for a table
node --import tsx skills/text2sql/scripts/query.ts schema --table <name>

# One sample row (default limit 1)
node --import tsx skills/text2sql/scripts/query.ts sample --table <name> [--limit 1]

# Run a SELECT (limit default 500, max 1000)
node --import tsx skills/text2sql/scripts/query.ts query --sql "SELECT ..." [--limit 500]
```

If Bun is available you can use `bun` instead of `node --import tsx`. The workspace must contain `skills/text2sql/` (e.g. the OpenClaw repo).
