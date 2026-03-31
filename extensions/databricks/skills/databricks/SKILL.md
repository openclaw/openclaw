---
name: databricks
description: Plan and execute Databricks workflows with OpenClaw's current runtime support for read-only SQL statement execution, plus guidance for jobs and governance planning.
---

Use this skill when the user asks to work with Databricks SQL, notebooks, jobs, or catalog governance tasks.

## Runtime support in this iteration

- Available runtime tool: `databricks_sql_readonly`
- Real execution support:
  - single-statement `SELECT`
  - single-statement `WITH ... SELECT`
- Enforced limits:
  - read-only only
  - mutating statements blocked
  - multi-statement SQL blocked

## Not implemented yet

- Jobs API execution
- Unity Catalog or lineage API calls
- Mutating SQL workflows

## Scope

- Execute read-only SQL via the runtime tool when the request fits allowed policy.
- Convert broader requests into safe, copy-paste ready plans when runtime support is not implemented yet.
- Prepare job/workflow and governance checklists as planning output only.

## Inputs to request early

- Workspace URL and target environment (`dev`, `staging`, or `prod`).
- SQL warehouse name or cluster policy constraints.
- Catalog, schema, and table scope.
- Job identifiers, schedules, and retry expectations.

## Output format defaults

- Keep outputs copy-paste ready for tickets and runbooks.
- Include:
  - short objective line
  - step-by-step execution plan
  - SQL draft or pseudo-query blocks when needed
  - risk notes, validation checks, and rollback signals

## SQL analysis template

When preparing SQL work, produce this structure:

1. Objective
2. Data scope and assumptions
3. Query draft (read-only)
4. Cost and performance considerations
5. Validation checklist

## Job orchestration template

When preparing Databricks job execution (planning only in this iteration):

1. Trigger mode (manual, scheduled, or event-based)
2. Task graph and dependencies
3. Runtime parameters and secrets handling notes
4. Failure and retry behavior
5. Post-run verification steps

## Governance follow-up template

For Unity Catalog and permissions follow-up (planning only in this iteration):

1. Assets in scope (catalogs, schemas, tables, volumes)
2. Current access model summary
3. Proposed permission changes
4. Audit logging checks
5. Sign-off and monitoring plan
