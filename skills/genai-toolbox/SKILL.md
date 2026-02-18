---
name: genai-toolbox
description: Google MCP Toolbox for Databases — start/stop the server, manage tools.yaml configs, query databases via MCP, and invoke tools. Use when working with database access through AI agents, creating SQL tool definitions, or managing the Toolbox MCP server.
---

# Google MCP Toolbox for Databases

## Binary

`genai-toolbox` at `~/.local/bin/genai-toolbox`

Source: `/home/i/projects/genai-toolbox` (fork of `googleapis/genai-toolbox`)

## Quick Start

```bash
# Start server with config
genai-toolbox --tools-file tools.yaml

# Start with MCP stdio mode (for IDE integration)
genai-toolbox --tools-file tools.yaml --stdio

# Start with UI
genai-toolbox --tools-file tools.yaml --ui

# Custom port
genai-toolbox --tools-file tools.yaml -p 5050 -a 0.0.0.0
```

## Config: tools.yaml

Tools are defined declaratively in YAML. Default location: `./tools.yaml`

### Minimal PostgreSQL Example

```yaml
sources:
  my-pg:
    kind: postgres
    host: localhost
    port: 5432
    database: mydb
    user: postgres
    password: ${DB_PASSWORD}

tools:
  list-users:
    kind: postgres-sql
    source: my-pg
    description: "List all users"
    statement: "SELECT id, name, email FROM users LIMIT $1"
    parameters:
      - name: limit
        type: integer
        description: "Max rows to return"
        default: 100
```

### SQLite Example (Local/Testing)

```yaml
sources:
  local-db:
    kind: sqlite
    database: ./data.db

tools:
  query-data:
    kind: sqlite-sql
    source: local-db
    description: "Query data table"
    statement: "SELECT * FROM data WHERE category = ?"
    parameters:
      - name: category
        type: string
        description: "Category to filter"
```

### Multiple Sources

```yaml
sources:
  pg-main:
    kind: postgres
    host: localhost
    port: 5432
    database: app
    user: app_user
    password: ${PG_PASSWORD}

  bq-analytics:
    kind: bigquery
    project: my-project
    dataset: analytics

tools:
  app-users:
    kind: postgres-sql
    source: pg-main
    description: "Get application users"
    statement: "SELECT * FROM users WHERE active = true"

  analytics-query:
    kind: bigquery-sql
    source: bq-analytics
    description: "Run analytics query"
    statement: "SELECT * FROM events WHERE date = @date"
    parameters:
      - name: date
        type: string
        description: "Date in YYYY-MM-DD format"
```

## CLI Flags

| Flag                | Default     | Description                      |
| ------------------- | ----------- | -------------------------------- |
| `--tools-file`      |             | Single YAML config file          |
| `--tools-files`     |             | Multiple YAML files (merged)     |
| `--tools-folder`    |             | Directory of YAML files          |
| `-a, --address`     | `127.0.0.1` | Listen address                   |
| `-p, --port`        | `5000`      | Listen port                      |
| `--stdio`           | `false`     | MCP stdio mode (for IDE)         |
| `--ui`              | `false`     | Launch web UI                    |
| `--log-level`       | `INFO`      | DEBUG/INFO/WARN/ERROR            |
| `--logging-format`  | `standard`  | standard or JSON                 |
| `--telemetry-gcp`   | `false`     | Export to GCP Monitoring         |
| `--telemetry-otlp`  |             | OTLP endpoint URL                |
| `--disable-reload`  | `false`     | Disable hot-reload of tools.yaml |
| `--allowed-origins` | `*`         | CORS origins                     |

## Supported Sources

| Kind                 | Database                                     |
| -------------------- | -------------------------------------------- |
| `postgres`           | PostgreSQL, AlloyDB, CockroachDB, YugabyteDB |
| `mysql`              | MySQL, MariaDB                               |
| `sqlite`             | SQLite                                       |
| `bigquery`           | Google BigQuery                              |
| `spanner`            | Google Spanner                               |
| `cloud-sql-postgres` | Cloud SQL (Postgres)                         |
| `cloud-sql-mysql`    | Cloud SQL (MySQL)                            |
| `cloud-sql-mssql`    | Cloud SQL (SQL Server)                       |
| `mssql`              | Microsoft SQL Server                         |
| `oracle`             | Oracle (godror)                              |
| `neo4j`              | Neo4j                                        |
| `mongodb`            | MongoDB                                      |
| `redis`              | Redis / Valkey                               |
| `cassandra`          | Apache Cassandra                             |
| `clickhouse`         | ClickHouse                                   |
| `snowflake`          | Snowflake                                    |
| `trino`              | Trino                                        |
| `elasticsearch`      | Elasticsearch                                |
| `firebird`           | Firebird                                     |
| `firestore`          | Google Firestore                             |
| `bigtable`           | Google Bigtable                              |
| `looker`             | Looker                                       |

## MCP Integration

The server exposes tools via MCP protocol. Connect from:

- Claude Code / Cursor / Windsurf / Cline (via `--stdio`)
- Any MCP client (via HTTP at `http://localhost:5000`)

### OpenClaw Integration

To use with OpenClaw's mcporter skill:

```bash
mcporter call genai-toolbox.list-users limit=50
```

Or configure in mcporter config as an MCP server endpoint.

## Process Management

```bash
# Start as background process
genai-toolbox --tools-file tools.yaml &

# Check if running
pgrep -f genai-toolbox

# Stop
pkill -f genai-toolbox
```

## References

- Full database configs: See `references/sources.md`
- Official docs: https://googleapis.github.io/genai-toolbox/
- GitHub: https://github.com/googleapis/genai-toolbox
