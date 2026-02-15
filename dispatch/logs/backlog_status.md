# Backlog Status

Canonical backlog source:

- `ai_dispatch_agile_project_package/backlog/backlog.csv`

Backlog hygiene rules:

- Keep active backlog items only in the canonical CSV above.
- Do not duplicate backlog rows in this log.
- Completed story history remains in `dispatch/logs/progress_log.md`.

Current active item:

- `V0-BOOTSTRAP` (v0 readiness lock and deterministic environment launch contract).
- Last completed work: `GLZ-03` (intake-to-schedulable guardrails and SOP handoff requirements).

Current planning cadence:

- Active sprint focus: `Sprint V0-1`.
- Active epic families: `EPIC-V0-COMPLETE` and `EPIC-GZ-01`.

Engineering handoff readiness:

- Handoff contract now lives in:
  - `ai_dispatch_agile_project_package/docs/12_Sprint_Plan.md`
  - `ai_dispatch_agile_project_package/docs/13_V0_Engineering_Readiness_Bundle.md`
- Sprint V0-1 gate is required before opening dependent stories:
  - `V0-BOOTSTRAP`
  - `V0-WORKER-LAUNCH`
  - `GLZ-01` through `GLZ-03`
