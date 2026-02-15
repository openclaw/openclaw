# Commercial Door & Glazing v1 Sprint Plan (v0 Completion Accelerator)

**Updated:** February 15, 2026

## 1) Planning Baseline

- Existing platform v0 + MVP backbone is available in this repo (`STORY-01` through `STORY-10`, `MVP-01` through `MVP-08`).
- New implementation objective: replace manual dispatch operations with a production-grade, mostly autonomous dispatch plane for a **commercial door and glazing repair business**.
- Primary outcomes:
  - receive blind work-order demand in normal channels,
  - process ticket lifecycle end-to-end to closeout,
  - enforce auditability/security at every state change,
  - increase automation safely using escalation gates and human override.
- Canonical backlog now lives in `ai_dispatch_agile_project_package/backlog/backlog.csv`.

## 2) Team Norms (Scrum Master Operating Cadence)

- Sprint length: **2 weeks**
- Core ceremonies:
  - Day 1 planning: capacity + commitment
  - Daily 15-minute standup: blockers + dependencies
  - Weekly mid-sprint backlog refinement for unblocked follow-up stories
  - Sprint review + retro at end of Week 2
- WIP limit:
  - 2 stories in parallel maximum for one owner role.
- Definition of Ready:
  - clear customer workflow trigger,
  - role permissions confirmed,
  - test data + event contract identified,
  - dependency chain resolved.
- Definition of Done:
  - endpoint/tests/contracts updated,
  - audit trail and evidence behavior explicit,
  - role/tool/state checks covered,
  - release note and runbook update recorded.

## 3) Engineering Execution Readiness (must be satisfied before a story starts)

- Start criteria for every story:
  - Required artifacts from previous story and dependency are present in git and pass code review.
  - Role constraints are mapped for every state transition.
  - API/event contracts and error codes are agreed and documented in implementation notes.
  - Test fixture set is available and can be replayed.
  - Incident escalation path is documented and owners are aware.
- Exit criteria for every story:
  - Story-level tests pass for success and one negative path.
  - Immutable audit write is added for each required state transition and closeout action.
  - Human override behavior is preserved where policy requires manual confirmation.
  - Story evidence (screenshots, logs, commands, request/response samples) is attached to the story ticket.
- Primary engineering intake for each sprint:
  - This plan,
  - backlog CSV as canonical source,
  - `13_V0_Engineering_Readiness_Bundle.md` for DoR/DoD and per-story acceptance details.
- Escalation rules for this sprint sequence:
  - Identity ambiguity or missing customer verification escalates to Intake owner.
  - Scheduling conflicts escalate to Scheduling owner and PM.
  - Evidence gap at closeout escalates to Technician Liaison and Closeout owner.
  - Any state transition that bypasses role checks halts the sprint and triggers architecture review.

## 3) Sprint V0-1 (Week 1): Readiness Baseline + Intake Lock

Goal: establish trusted intake that can classify and prep schedulable glass/service incidents without losing data quality.

Stories:

### New v0-completion additions

- `V0-BOOTSTRAP` readiness baseline and deterministic seed/launch contract
- `V0-WORKER-LAUNCH` placeholder-to-real-worker migration planning work (job loop + shutdown contracts)

### Story set

- `GLZ-01` Intake API and required-field policy for blind orders
- `GLZ-02` Address/site dedupe and job identity keying
- `GLZ-03` Intake-to-schedulable state transition guardrails and required SOP handoff

Exit criteria:

- triage-only inbound tickets are rejected unless all minimum fields are present,
- customer/contact/address, issue type, urgency, and SLA fields are persisted in case file,
- every `GLZ-01`/`GLZ-02` action writes immutable audit events with actor and correlation metadata,
- first complete e2e path from intake to schedulable is repeatable and deterministic.

## 4) Sprint V0-2 (Week 2): Dispatch Planning and Scheduling + Lifecycle Proof

Goal: move from triaged/schedulable cases into scheduled and dispatched states with policy control.

Stories:

- `GLZ-04` Dispatch queue prioritization by region, urgency, and promised SLA
- `GLZ-05` Technician skill/location matching engine for assignment recommendation
- `GLZ-06` Customer confirmation + schedule hold/release command chain
- `V0-E2E-LOCK` one-command command-chain proof for full v0 path

Exit criteria:

- assignment events are derived from a traceable policy input (not manual ad hoc edits),
- schedule confirmation updates timeline and audit in one immutable transaction,
- fail-closed behavior when technician availability is unavailable or customer confirmation is stale,
- no state transition bypass between `schedulable` and `dispatched`.

## 5) Sprint V0-3 (Week 3): Technician Autonomy and Field Evidence

Goal: implement field autonomy-safe execution support while preserving human override controls.

Stories:

- `GLZ-07` Technician job packet API with check-in/check-out lifecycle state transitions
- `GLZ-08` Evidence capture contract (photos, notes, labor, parts, signature, closeout attachments)
- `GLZ-09` Blind closeout candidate automation with mandatory evidence gates

Exit criteria:

- every field update and evidence event creates audit + timeline entries,
- evidence completeness is enforced before allowing `closeout_pending`,
- technician autonomy actions produce explicit pending/operator-visible exceptions when escalation is required,
- command-only transitions (`tech.check_in`, `tech.complete`, `closeout.submit`) verified.

## 6) Sprint V0-4 (Week 4): Billing, Control, and Hardening to Pilot

Goal: close financial loop and operational resilience for production launch.

Stories:

- `GLZ-10` Invoice draft generation with line-item mapping from parts/labor evidence
- `GLZ-11` Commercial control dashboard and alerting for blind automation
- `GLZ-12` Operator override and rollback drill playbook for dispatch autonomy
- `V0-LAUNCH-GATE` pilot readiness checklist and evidence packet freeze

Exit criteria:

- invoice artifact is generated only after closeout evidence and signature pass gates,
- alerting covers at minimum failed assignment, evidence-missing completion, SLA breach trend, and override usage spikes,
- rollback/recovery drill for one synthetic blind order completes end-to-end without data loss.

## 7) Delivery Plan and Dependency Order

Planned sequence:

Sequence now emphasizes v0-completion acceleration:

- Sprint V0-1: `V0-BOOTSTRAP` -> `V0-WORKER-LAUNCH` -> `GLZ-01` -> `GLZ-02` -> `GLZ-03`
- Sprint V0-2: `GLZ-04` -> `GLZ-05` -> `GLZ-06` -> `V0-E2E-LOCK` (depends on V0-1)
- Sprint V0-3: `GLZ-07` -> `GLZ-08` -> `GLZ-09` (depends on V0-2)
- Sprint V0-4: `GLZ-10` -> `GLZ-11` -> `GLZ-12` -> `V0-LAUNCH-GATE` (depends on V0-3)

## 8) Tracking Rules

- Active backlog source: `backlog/backlog.csv`
- Current work item marker: `dispatch/logs/current_work_item.md`
- Completion evidence log: `dispatch/logs/progress_log.md`
- No duplicate backlog tables in status logs. Only canonical rows in CSV and recommendations in `dispatch/logs/next_story_recommendation.md`.

## 9) Deliverable Packet for Dev Team

- Dev-ready handoff bundle:
  - `ai_dispatch_agile_project_package/backlog/backlog.csv`
  - `ai_dispatch_agile_project_package/docs/13_V0_Engineering_Readiness_Bundle.md`
  - `dispatch/logs/backlog_status.md`
  - `dispatch/logs/next_story_recommendation.md`
- Sprint 0 completion is a readiness-to-demo condition for internal pilot, not a marketing demo artifact.
- A sprint is considered complete only after:
  - code changes are merged into the mainline branch,
  - acceptance checklist in the readiness bundle is checked per story,
  - and the launch gate artifact is produced by the end of Sprint V0-4.
