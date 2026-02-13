# AI-First Dispatch Agent — Agile Project Package (Standalone)

**Generated:** 2026-02-13  
**Purpose:** A complete, end-to-end agile delivery package for building an AI-first dispatch agent and its enforcement service (**dispatch-api**) with strong auditability, closed-tool gating, and E2E proof.

This package is designed to align with the orchestration patterns we discussed (NEST-like IFM + enterprise door service), while staying practical for a first deployment inside *your own door service company* and scaling later to multi-site / third-party provider networks.

---

## What’s in this zip

### Core product + engineering docs
- `docs/01_PRD_v0.md` — v0 minimum shippable dispatch PRD (scope-locked)
- `docs/02_Workflows_and_State_Machine.md` — canonical lifecycle, edge cases, SOP anchors
- `docs/03_System_Architecture.md` — boundaries, idempotency, audit/event model
- `docs/04_Data_Model.md` + `db/migrations/*.sql` — Postgres schema + constraints
- `docs/05_API_Spec_OpenAPI.yaml` — OpenAPI sketch (command-style endpoints)
- `docs/06_Tool_Surface_and_OpenClaw_Integration.md` — closed toolset + allowlisting patterns
- `docs/07_Security_Threat_Model.md` — threat model + mitigations (tool abuse, prompt injection, authz)
- `docs/08_Observability_and_Runbooks.md` — logs/metrics/traces + on-call runbooks
- `docs/09_Test_Strategy_and_E2E_Harness.md` — contract → integration → E2E acceptance chain
- `docs/10_RACI_and_Deliverables.md` — ownership map across “expert roles”
- `backlog/backlog_v0.csv` — agile backlog (epics/stories/tasks) importable to Jira/Linear/etc.
- `backlog/acceptance_criteria_checklist.md` — non-negotiable v0 acceptance list

### SOP library (starting point)
- `sops/intake/` — scripts + required fields per incident type
- `sops/field/` — checklists + evidence requirements
- `sops/closeout/` — verification + billing readiness

### DevOps + scaffolding templates
- `ops/docker-compose.yaml` — local topology (gateway placeholder + dispatch-api + postgres + minio)
- `ops/Dockerfile.dispatch-api.example` — example container build approach
- `ops/env.example` — environment variables
- `ops/ci.example.yaml` — CI outline (build, unit, migration, integration, E2E)

### Event schemas
- `schemas/audit_event.schema.json` — JSON Schema for append-only audit events
- `schemas/tool_invocation.schema.json` — tool invocation envelope schema
- `schemas/state_transition.schema.json` — state transition event schema

---

## How to use this package with your repo

This package intentionally mirrors common repo layout hints like:

- `/dispatch/api` → your runtime enforcement service (**dispatch-api**)
- `/dispatch/ops` → compose, Dockerfiles, CI plumbing
- `/src/contracts` → tool + policy contracts
- `/src/plugins` → tool bridge (OpenClaw integration)
- `/dispatch/e2e` → deterministic end-to-end tests

If you already have those folders, you can copy the relevant files directly into them.

---

## What “v0” means here

**v0 = minimum shippable dispatch** with:
- a closed toolset that only mutates state via **dispatch-api**
- idempotent mutation endpoints
- append-only audit trail for every mutation
- one canonical E2E scenario that proves the entire chain locally and in CI

Everything else (advanced optimization, learning policies, full provider marketplace) is deferred to v1+.

---

## Quick start (local dev topology)

This package includes **templates**. You will still implement the actual service code.

1. Review `docs/01_PRD_v0.md` and lock scope.
2. Review `docs/04_Data_Model.md` and run migrations in your Postgres.
3. Implement `dispatch-api` endpoints in your chosen stack.
4. Wire your OpenClaw tool bridge to call `dispatch-api` (see `docs/06_*`).
5. Make the E2E harness pass (`docs/09_*` + `backlog/acceptance_criteria_checklist.md`).

---

## License / reuse

This package is generated for your internal use; adapt freely.

