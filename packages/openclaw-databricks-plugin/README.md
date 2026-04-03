# OpenClaw Databricks Plugin

External OpenClaw plugin for conservative Databricks SQL access.

This package provides:

- Runtime tool: `databricks_sql_readonly`
- Skill pack: `databricks`
- Read-only SQL execution only (`SELECT` or `WITH ... SELECT`)

## Install

Preferred:

```bash
openclaw plugins install @kansodata/openclaw-databricks-plugin
```

Source-specific:

```bash
openclaw plugins install clawhub:@kansodata/openclaw-databricks-plugin
openclaw plugins install npm:@kansodata/openclaw-databricks-plugin
```

OpenClaw checks ClawHub first for bare package installs, then falls back to npm.

## Configure

Plugin key: `plugins.entries.databricks`

```json
{
  "plugins": {
    "entries": {
      "databricks": {
        "enabled": true,
        "config": {
          "host": "https://dbc-example.cloud.databricks.com",
          "token": "dapi...",
          "warehouseId": "abc123",
          "readOnly": true
        }
      }
    }
  }
}
```

Restart gateway after configuration changes.

## Configuration Fields

Required:

- `host`
- `token`
- `warehouseId`

Optional:

- `timeoutMs` (default `30000`)
- `retryCount` (default `1`, range `0..3`)
- `pollingIntervalMs` (default `1000`)
- `maxPollingWaitMs` (default `30000`)
- `allowedCatalogs` (default `[]`)
- `allowedSchemas` (default `[]`)
- `readOnly` (must stay `true`)

Environment fallbacks:

- `DATABRICKS_HOST`
- `DATABRICKS_TOKEN`
- `DATABRICKS_WAREHOUSE_ID`
- `DATABRICKS_READ_ONLY`

## Security and Hardening

- Fail-closed host validation:
  - HTTPS only
  - No path/query/fragment/userinfo/custom port
  - No localhost/IP literals
  - Hostname must match Databricks suffixes (`*.cloud.databricks.com`, `*.azuredatabricks.net`, `*.gcp.databricks.com`)
- Token and sensitive values are redacted in runtime logs and normalized error output.
- SQL policy is read-only and blocks mutating keywords and multi-statement input.
- Allowlists are enforced conservatively:
  - If targets cannot be resolved safely, request is rejected.
  - Ambiguous target syntax is rejected when allowlists are configured.
  - `catalog` and `schema` request parameters do not bypass SQL target checks.

## Runtime Behavior

`databricks_sql_readonly`:

- Submits SQL via Databricks SQL Statements API.
- Polls statement status until a terminal state or timeout budget exhaustion.
- Treats `SUCCEEDED` as success.
- Treats `FAILED` / `CANCELED` as explicit failures.
- Uses `retryCount` for transient submit and poll failures (`429`, `408`, `5xx`, and timeout aborts).

## Scope Limits

Out of scope in this version:

- Jobs API execution
- Unity Catalog lineage APIs
- Any mutating SQL support

## Publish Notes

This package is intended for external distribution (ClawHub/npm), not bundled OpenClaw core.
