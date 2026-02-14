# Backlog Status (Derived, Do Not Edit Source CSV)

| Story ID | Epic | Priority | Status | Notes |
|---|---|---|---|---|
| STORY-01 | EPIC-01: v0 Dispatch API Spine | P0 | COMPLETE | Implemented command enforcement endpoints (`POST /tickets`, `POST /tickets/{id}/triage`, `POST /tickets/{id}/schedule/confirm`, `POST /tickets/{id}/assignment/dispatch`) with required idempotency key, replay semantics, payload-mismatch `409`, fail-closed transition checks, and audit+transition writes. Node-native integration tests pass. |
| STORY-02 | EPIC-01: v0 Dispatch API Spine | P0 | COMPLETE | Implemented `GET /tickets/{ticketId}/timeline` with fail-closed UUID validation, deterministic ordering (`created_at ASC, id ASC`), and required audit field coverage checks backed by node-native tests. |
| STORY-03 | EPIC-02: Postgres Schema + Migrations | P0 | COMPLETE | Implemented in `dispatch/db/migrations/001_init.sql`; validated on clean Postgres DB with fail-closed checks. |
| STORY-04 | EPIC-03: Closed Toolset + Integration | P0 | COMPLETE | Implemented closed tool bridge with allowlisted tool-to-endpoint mappings, deny-by-default unknown-tool rejection, per-role bridge gating, and request/correlation propagation validation via node-native integration tests. |
| STORY-05 | EPIC-03: Closed Toolset + Integration | P0 | COMPLETE | Added authoritative server-side role/tool/state authorization hardening, enforced endpoint tool-name checks (`TOOL_NOT_ALLOWED`), centralized state-context policy checks, and synchronized bridge/API policies via shared module with node-native coverage. |
| STORY-06 | EPIC-04: Evidence + Incident Templates | P0 | COMPLETE | Implemented versioned incident template policy model with deterministic loader/parser and fail-closed closeout readiness evaluation for required evidence/checklist gates. |
| STORY-07 | EPIC-04: Evidence + Incident Templates | P0 | COMPLETE | Implemented evidence attach/list endpoints over `evidence_items` plus fail-closed `tech.complete` gating against persisted `metadata.evidence_key` references and checklist status with deterministic integration coverage. |
| STORY-08 | EPIC-05: E2E Proof | P0 | COMPLETE | Added deterministic canonical emergency E2E harness via tool bridge, including fail-closed missing-evidence rejection, idempotent evidence replay assertions, and timeline/audit/transition integrity checks. |
| STORY-09 | EPIC-06: Observability | P1 | COMPLETE | Added structured per-request logging envelope with request/correlation/trace context and exported `/metrics` counters for requests/errors/transitions plus idempotency replay/conflict tracking. |
| STORY-10 | EPIC-07: UX (v0 minimal) | P1 | COMPLETE | Published v0 UX specification package for dispatcher cockpit and technician job packet, including SLA timers, assignment override flow, timeline view, and closeout evidence/checklist requirements. |

## Post-v0 MVP Alignment Backlog (2026-02-14)

| Story ID | Epic | Priority | Status | Notes |
|---|---|---|---|---|
| MVP-01 | EPIC-MVP-01: API + Lifecycle Parity | P0 | COMPLETE | Delivered missing command/read endpoints (`schedule.propose`, `tech.check-in`, `tech.request-change`, `approval.decide`, `qa.verify`, `billing/generate-invoice`, `GET /tickets/{id}`), extended shared policy/tool docs, and added `dispatch/tests/mvp_01_api_parity.node.test.mjs`. Validation: `node --test dispatch/tests/mvp_01_api_parity.node.test.mjs` and `node --test dispatch/tests/*.mjs` (36/36 passing). |
| MVP-02 | EPIC-MVP-01: API + Lifecycle Parity | P0 | COMPLETE | Removed canonical E2E DB shim and converted `dispatch/tests/story_08_e2e_canonical.node.test.mjs` to command-only progression (`tech.check_in` + `qa.verify` + `billing.generate_invoice`) with fail-closed and idempotency assertions retained. Validation: `node --test dispatch/tests/story_08_e2e_canonical.node.test.mjs` and `node --test --test-concurrency=1 dispatch/tests/*.mjs` (36/36 passing). |
| MVP-03 | EPIC-MVP-02: Security Hardening | P0 | READY | Replace header-trust actor context with signed claims authn/authz, role binding, and scoped access checks. |
| MVP-04 | EPIC-MVP-03: Evidence Hardening | P0 | READY | Enforce signature-or-explicit-no-signature-reason policy and object-store evidence reference validation. |
| MVP-05 | EPIC-MVP-04: Quality Gates | P0 | READY | Add dispatch story suite + canonical E2E to CI as blocking release gates with one-command local parity checks. |
| MVP-06 | EPIC-MVP-05: Operability | P1 | READY | Wire durable metrics/log sinks, alerting, and runbooks for stuck scheduling, completion rejection, idempotency conflict, and auth policy failures. |
| MVP-07 | EPIC-MVP-06: UX MVP Build | P1 | READY | Implement dispatcher cockpit + technician packet interactive workflows backed strictly by dispatch-api commands. |
| MVP-08 | EPIC-MVP-07: Pilot Readiness | P1 | BLOCKED_BY_MVP-03 | Execute ops SME UAT, rollback rehearsal, and release candidate freeze for first pilot cutover. |
