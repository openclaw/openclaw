---
name: databricks
description: Execute conservative read-only Databricks SQL through the Databricks plugin and provide safe planning output for unsupported workflows.
---

Use this skill when a user asks for Databricks SQL analysis or execution.

## Runtime Scope

Available runtime tool:

- `databricks_sql_readonly`

Supported statement shapes:

- Single `SELECT`
- Single `WITH ... SELECT`

Policy constraints:

- Read-only only
- Multi-statement SQL blocked
- Mutating keywords blocked
- Optional catalog/schema allowlists enforced fail-closed
- Ambiguous SQL target resolution rejected when allowlists are active

## Unsupported in This Version

- Jobs API execution
- Unity Catalog lineage API calls
- Mutating SQL operations

For unsupported requests, provide planning output only.

## Required Inputs

- Databricks workspace URL and environment (`dev`, `staging`, `prod`)
- SQL warehouse identifier
- Catalog and schema scope
- Target table set

## Output Defaults

- Objective
- Assumptions
- Read-only SQL draft
- Validation checklist
- Risk notes and rollback signals
