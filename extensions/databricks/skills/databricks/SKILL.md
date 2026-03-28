---
name: databricks
description: Plan and execute Databricks workflows for SQL analytics, jobs orchestration, and Unity Catalog governance follow-up.
---

Use this skill when the user asks to work with Databricks SQL, notebooks, jobs, or catalog governance tasks.

## Scope

- Convert analysis requests into runnable Databricks SQL drafts.
- Prepare job and workflow execution plans with pre-run and post-run checks.
- Build governance and access review checklists for Unity Catalog objects.

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
3. Query draft
4. Cost and performance considerations
5. Validation checklist

## Job orchestration template

When preparing Databricks job execution:

1. Trigger mode (manual, scheduled, or event-based)
2. Task graph and dependencies
3. Runtime parameters and secrets handling notes
4. Failure and retry behavior
5. Post-run verification steps

## Governance follow-up template

For Unity Catalog and permissions follow-up:

1. Assets in scope (catalogs, schemas, tables, volumes)
2. Current access model summary
3. Proposed permission changes
4. Audit logging checks
5. Sign-off and monitoring plan
