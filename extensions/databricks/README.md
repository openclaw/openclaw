# Databricks (plugin)

Adds a Databricks plugin with a minimal runtime capability and a skill bundle.

## Install

```bash
openclaw plugins install @openclaw/databricks
```

## Enable

```json
{
  "plugins": {
    "entries": {
      "databricks": { "enabled": true }
    }
  }
}
```

Restart the gateway after enabling.

## What you get

- Runtime tool: `databricks_sql_readonly`
  - Executes a single SQL statement through Databricks SQL Statements API
  - Polls statement status when Databricks responds `PENDING`/`RUNNING`/`QUEUED`
  - Retries transient polling failures (`429`/`5xx`) with bounded backoff inside `maxPollingWaitMs`
  - Enforces read-only policy: only `SELECT` or `WITH ... SELECT`
  - Blocks mutating SQL and multiple statements
  - Supports optional catalog/schema allowlists
- `databricks` skill available to the agent

## Required config

Configure `plugins.entries.databricks.config` with:

- `host`
- `token`
- `warehouseId`
- optional `timeoutMs` (default `30000`)
- optional `retryCount` (default `1`)
- optional `pollingIntervalMs` (default `1000`)
- optional `maxPollingWaitMs` (default `30000`)
- optional `allowedCatalogs` (empty by default)
- optional `allowedSchemas` (empty by default)
- optional `readOnly` (default `true`, and must remain `true` in this iteration)

Environment fallbacks are supported:

- `DATABRICKS_HOST`
- `DATABRICKS_TOKEN`
- `DATABRICKS_WAREHOUSE_ID`
- `DATABRICKS_READ_ONLY`

## Current limits (intentional)

- No Jobs API execution yet
- No Unity Catalog/lineage API integration yet
- No mutating SQL operations in this iteration
- Allowlist checks are conservative:
  - if an allowlist is configured and query targets cannot be determined safely from SQL, the query is rejected (fail-closed)
  - single-part table references (for example `FROM orders`) are treated as ambiguous when allowlists are active
  - explicit `catalog`/`schema` request parameters do not bypass SQL target validation
