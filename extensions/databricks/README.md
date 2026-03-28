# Databricks (plugin)

Adds a Databricks skill bundle for analytics engineering, SQL operations, and job orchestration workflows.

## Install

```bash
openclaw plugins install @kansodata/databricks
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

- `databricks` skill available to the agent
- Practical playbook for:
  - SQL warehouse analysis and optimization
  - notebook/job run planning and post-run checks
  - Unity Catalog aware data governance checklists
