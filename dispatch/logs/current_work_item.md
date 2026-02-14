# Current Work Item

## Story ID
`STORY-06: Incident templates + evidence requirement policy model`

## Epic
`EPIC-04: Evidence + Incident Templates`

## Priority
`P0`

## Acceptance Criteria (from backlog)
- Incident/evidence template policy model is implemented.
- Required evidence gates are representable per incident type.
- Completion-readiness checks can consume template requirements deterministically.

## Why This Was Selected
`STORY-05` is now complete and closes the role/tool/state authorization hardening gap. The next dependency-valid P0 item is evidence-template enforcement modeling, which is required before implementing strict closeout evidence gates and canonical policy-violation E2E checks.

## Dependency Check
- Schema/migrations: satisfied (`STORY-03` complete).
- Command path + idempotency: satisfied (`STORY-01` complete).
- Timeline/audit completeness: satisfied (`STORY-02` complete).
- Closed bridge mapping: satisfied (`STORY-04` complete).
- Server-side role/tool/state auth hardening: satisfied (`STORY-05` complete).
- Evidence template model before artifact enforcement: pending in this story.

## Deterministic Scope for Next Cycle
- Define incident template schema with required evidence/checklist gates.
- Add persistence/read APIs or configuration loaders for template lookup.
- Add fail-closed validator for missing required closeout evidence against selected template.
- Add node-native tests for template selection and missing-evidence rejection decisions.
