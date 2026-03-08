# MSSQL Expert Skill

Advanced diagnostics, health checks, and performance analysis for Microsoft SQL Server.

## Features

- **Health Check:** basic connectivity, version, uptime, and database states.
- **Performance Analysis:** Identify high CPU queries, missing indexes, wait statistics, and potential bottlenecks.
- **Optimization:** Generate suggestions for index maintenance and configuration tuning.

## Requirements

- Node.js environment
- Network access to the target SQL Server
- Credentials with `VIEW SERVER STATE` permission (for performance DMVs).

## Usage

Use the `run` tool to execute the skill script.

### Actions

1. **status**
   Checks connectivity and returns server info.
   `node index.js status --server <ip> --user <sa> --password <pw>`

2. **analyze**
   Runs deep performance diagnostics (Top Queries, Missing Indexes).
   `node index.js analyze --server <ip> --user <sa> --password <pw>`

## Output

Returns JSON structured data ready for LLM interpretation.
