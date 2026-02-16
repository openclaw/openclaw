# Legacy ID Migration Appendix (Non-Authoritative)

Canonical planning source remains:

- `real-dispatch-agile-package/README.md`
- `real-dispatch-agile-package/02-Backlog/02-Stories.md`
- `real-dispatch-agile-package/03-Delivery/Current-Sprint.md`

This appendix is for transition context only. New work should use `E#-F#-S#` IDs as the source of truth.

## Legacy → E/F/S quick map

| Legacy ID       | Legacy intent                                        | New ID (E/F/S)                     | Repository evidence pointer                                                                 | Status                                                                                       |
| --------------- | ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GLZ-04`        | Dispatch queue prioritization + ordering             | `TBD`                              | `dispatch/logs/story_glz_04_contract.md`                                                    | Pending: requires explicit vNext command-scheduling equivalent                               |
| `GLZ-05`        | Assignment recommendation + readiness                | `TBD`                              | `dispatch/logs/story_glz_05_contract.md`                                                    | Pending: overlaps with control-plane/workflow planning themes                                |
| `GLZ-06`        | Customer confirmation hold/release + rollback chain  | `E7-F2-S1` _(partial)_             | `dispatch/logs/story_glz_06_contract.md`                                                    | Partial: vNext includes autonomy pause concepts but not identical implementation yet         |
| `GLZ-09`        | Blind closeout candidate automation + manual review  | `E3-F3-S3` _(partial)_             | `dispatch/logs/story_glz_09_contract.md`                                                    | Partial: closeout-risk escalation still has gaps in vNext                                    |
| `STORY-01`      | Command endpoints + idempotency                      | `E2-F1-S1`, `E2-F2-S1` _(split)_   | `dispatch/logs/story_01_contract.md`, `dispatch/tests/story_01_idempotency.node.test.mjs`   | Partial overlap across two new stories                                                       |
| `STORY-02`      | Append-only audit completeness + timeline            | `E2-F1-S1` _(partial)_             | `dispatch/logs/story_02_contract.md`, `dispatch/tests/story_02_timeline.node.test.mjs`      | Partial: audit contract is carried into vNext DoD and contracts                              |
| `STORY-03`      | State migration + DB integrity constraints           | `E11-F1-S1` _(partial)_            | `dispatch/db/migrations/001_init.sql`, `dispatch/tests/001_init_migration.node.test.mjs`    | Partial: vNext does not yet define a one-to-one migration story                              |
| `STORY-04`      | Closed tool mapping + policy-aligned tool invocation | `E3-F1-S1` _(partial)_             | `dispatch/logs/story_04_contract.md`                                                        | Partial: vNext policy layer is in-progress                                                   |
| `STORY-05`      | Role/tool/state authorization hardening              | `E3-F2-S1` _(partial)_             | `dispatch/logs/story_05_contract.md`                                                        | Partial: policy decisions/bundle loader are active vNext tracks                              |
| `STORY-06`      | Incident templates + evidence policy modeling        | `E5-F2-S1` _(partial)_             | `dispatch/logs/story_06_contract.md`                                                        | Partial: not yet explicitly split in vNext                                                   |
| `STORY-07`      | Evidence API/ref integration                         | `E3-F3-S3`, `E5-F1-S1` _(partial)_ | `dispatch/logs/story_07_contract.md`                                                        | Partial: closeout evidence hardening spread across early vNext features                      |
| `STORY-08`      | Canonical E2E harness + failure-path checks          | `E4-F2-S1` _(partial)_             | `dispatch/logs/story_08_contract.md`, `dispatch/tests/story_08_e2e_canonical.node.test.mjs` | Partial: E2E scaffolding now includes workflow/outbox prerequisites                          |
| `STORY-09`      | Structured request logging + metrics                 | `E5-F2-S1` _(partial)_             | `dispatch/logs/story_09_contract.md`                                                        | Partial: observability requirements covered in DoD + release gates                           |
| `STORY-10`      | Dispatcher cockpit + tech packet specification       | `E7-F1-S1` _(partial)_             | `dispatch/logs/story_10_contract.md`                                                        | Partial: vNext UX/control-plane handoff artifact not yet mapped to one story                 |
| `MVP-01`        | API/lifecycle parity for dispatch commands           | `E2-F1-S1`, `E2-F2-S1` _(partial)_ | `dispatch/logs/progress_log.md`, `dispatch/logs/story_01_contract.md`                       | Partial: legacy milestone includes broader parity scope                                      |
| `MVP-02`        | Evidence/signature hardening + closeout behavior     | `E3-F3-S3`, `E5-F1-S1` _(partial)_ | `dispatch/logs/progress_log.md`, `real-dispatch-agile-package/02-Backlog/02-Stories.md`     | Partial: same risk family, split across control-plane and data-plane work                    |
| `MVP-03`        | Production authn/authz claims                        | `E3-F1-S1` _(partial)_             | `dispatch/logs/progress_log.md`                                                             | Partial: vNext policy decision persistence exists; production claims plumbing not yet linked |
| `MVP-04`        | Evidence enforcement + object-store validation       | `E3-F3-S3`, `E5-F1-S1` _(partial)_ | `dispatch/logs/progress_log.md`                                                             | Partial: evidence reference path shifts to contracts/control-plane model                     |
| `MVP-05`        | CI blocking quality gates                            | `E1-F1-S1` _(partial)_             | `.github/workflows/ci.yml`, `dispatch/tests`                                                | Partial: CI remains project-wide and still evolving for control-plane                        |
| `MVP-06`        | Observability and runbook readiness                  | `E12-F1-S1` _(partial)_            | `dispatch/logs/progress_log.md`, `real-dispatch-agile-package/03-Delivery/03-PR-Plan.md`    | Partial overlap in runbook/evidence dashboards                                               |
| `MVP-07`        | Dispatcher + technician packet surfaces              | `E7-F1-S1` _(partial)_             | `dispatch/logs/progress_log.md`                                                             | Partial: packet/surface work continues in later vNext design                                 |
| `MVP-08`        | Pilot UAT + cutover readiness                        | `TBD`                              | `dispatch/logs/progress_log.md`                                                             | Pending explicit vNext milestone equivalent                                                  |
| `MVP-ALIGNMENT` | Transition and roadmap planning artifact             | `TBD`                              | `dispatch/logs/progress_log.md`                                                             | Non-implementation planning artifact retained for history                                    |

## Update rule

- `legacy-id-map.md` remains transition-only context and is included in Sprint 1 governance PRs only for traceability alignment, not for runtime behavior.

- Add a row only when a recurring legacy ID causes operational ambiguity.
- If a legacy row gains a true one-to-one `E/F/S` mapping, update the row to `Exact` and keep prior notes as audit context.
