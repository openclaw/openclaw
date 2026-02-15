# @openclaw/mindsdb

OpenClaw plugin that adds an optional `mindsdb` agent tool for MindsDB's Federated Query Engine.

## What it does

- Executes SQL through `POST /api/sql/query`
- Supports named query params (`params`) and context (`context`)
- Exposes `list_databases` and `parametrize_constants` utility actions
- Supports auth via static bearer token or username/password login (`/api/login`)

## Enable

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
          "maxRows": 100,
          "maxChars": 30000
        }
      }
    }
  },
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

The tool is registered with `optional: true`, so you must allowlist it.

## Tool actions

- `query`: execute SQL (`query` required)
- `list_databases`: call `GET /api/sql/list_databases`
- `parametrize_constants`: call `POST /api/sql/query/utils/parametrize_constants` (`query` required)

## Security defaults

- `allowMutatingQueries` defaults to `false` and blocks mutating SQL statements.
- Enable mutations only when you intentionally want agents to run DDL/DML.
