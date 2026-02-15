---
summary: "Query any MindsDB-connected database from OpenClaw agents"
read_when:
  - You want OpenClaw agents to query databases through MindsDB
  - You are configuring the MindsDB plugin tool
title: "MindsDB"
---

# MindsDB

`mindsdb` is an optional plugin tool that lets OpenClaw agents run SQL through
MindsDB's Federated Query Engine.

Use it when you want one OpenClaw tool to query many backends (Postgres,
Snowflake, BigQuery, MySQL, and more) through a single MindsDB endpoint.

## Enable plugin + tool

1. Install/enable plugin:

```bash
openclaw plugins install @openclaw/mindsdb
openclaw plugins enable mindsdb
```

2. Allowlist the optional tool:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["mindsdb"] }
      }
    ]
  }
}
```

3. Configure plugin:

```json
{
  "plugins": {
    "entries": {
      "mindsdb": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:47334",
          "token": "<mindsdb-token>",
          "allowMutatingQueries": false,
          "requestTimeoutMs": 30000,
          "maxRows": 100,
          "maxChars": 30000
        }
      }
    }
  }
}
```

Restart the Gateway after config changes.

## Agent discovery

This plugin ships a bundled `mindsdb` skill (loaded when the plugin is enabled)
so agents can recognize when MindsDB is the right path for cross-database SQL.

## Auth modes

Use one of:

- `token`: static bearer token (recommended)
- `username` + `password`: tool logs in via `/api/login` and caches returned token
- No auth: for local MindsDB with HTTP auth disabled

Environment fallbacks are supported:

- `MINDSDB_URL` / `MINDSDB_API_URL`
- `MINDSDB_TOKEN`
- `MINDSDB_USERNAME`
- `MINDSDB_PASSWORD`

## Tool API

`action` values:

- `query`
- `list_databases`
- `parametrize_constants`

Parameters:

- `action` (required)
- `query` (required for `query` and `parametrize_constants`)
- `params` (optional object; named SQL params for `query`)
- `context` (optional object; forwarded to `/api/sql/query`)

## Safety defaults

By default, `allowMutatingQueries` is `false`.

That blocks statements that do not start with a read-style prefix (`SELECT`,
`SHOW`, `DESCRIBE`, `EXPLAIN`, `WITH`, `USE`).

Enable mutating queries only when you intentionally want agents to run DDL/DML
(creating databases, inserting rows, dropping objects, etc).

## Example invocations

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

Utility endpoint:

```json
{
  "action": "parametrize_constants",
  "query": "INSERT INTO postgres.employees (employee_id, first_name) VALUES (101, 'John')"
}
```
