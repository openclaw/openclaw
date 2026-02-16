# Legacy ID → E/F/S Mapping Appendix

Non-authoritative, orientation only.

- Legacy IDs are historical v0 references.
- New planning uses `E#-F#-S#` IDs as the source of truth.
- If a mapping is ambiguous, prefer the linked log entry or commit that established intent.

| Legacy ID  | Legacy title                                         | vNext Epic/Feature/Story | Status  | Primary evidence (link)                         | Notes                                                                                                                                     |
| ---------- | ---------------------------------------------------- | ------------------------ | ------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GLZ-04`   | Dispatch queue prioritization + ordering             | `TBD`                    | Pending | `dispatch/logs/story_glz_04_contract.md`        | Legacy ordering dependency currently precedes vNext scheduling work; see control-plane planning notes before claiming direct equivalence. |
| `GLZ-05`   | Assignment recommendation + readiness                | `TBD`                    | Pending | `dispatch/logs/story_glz_05_contract.md`        | Capability matching currently spans data-plane hardening and workflow planning; one-to-one mapping not yet finalized.                     |
| `GLZ-06`   | Customer confirmation hold/release/rollback chain    | `E7-F2-S1` _(partial)_   | Partial | `dispatch/logs/story_glz_06_contract.md`        | vNext captures pause/rollout control concepts, but command semantics are not yet identical.                                               |
| `GLZ-09`   | Blind closeout candidate automation + manual review  | `E3-F3-S3` _(partial)_   | Partial | `dispatch/logs/story_glz_09_contract.md`        | Closeout risk escalation remains partly split with policy and evidence-readiness tracks.                                                  |
| `STORY-01` | Implement command endpoints with idempotency         | `E2-F1-S1`, `E2-F2-S1`   | Split   | `dispatch/logs/story_01_contract.md`            | Legacy story requirements are decomposed into normalization and idempotency replay control-plane tasks.                                   |
| `STORY-02` | Append-only audit completeness + timeline endpoint   | `E2-F1-S1`               | Partial | `dispatch/logs/story_02_contract.md`            | Audit + timeline are now part of broader evidence and control auditability contract.                                                      |
| `STORY-04` | Closed tool mapping + policy-aligned tool invocation | `E3-F1-S1`               | Partial | `dispatch/logs/story_04_contract.md`            | Policy and mapping concerns are now anchored in command decisions and policy bundles.                                                     |
| `STORY-05` | Server-side role/tool/state authorization hardening  | `E3-F2-S1`               | Partial | `dispatch/logs/story_05_contract.md`            | Authorization hardening is carried through into vNext policy decision persistence and guard layers.                                       |
| `STORY-06` | Incident templates + evidence-policy model           | `E5-F2-S1`               | Partial | `dispatch/logs/story_06_contract.md`            | Evidence policy continues, but model now sits in contracts/control-plane data objects.                                                    |
| `STORY-07` | Evidence API + object-store reference integration    | `E5-F1-S1`               | Partial | `dispatch/logs/story_07_contract.md`            | Evidence lifecycle is partially merged with closeout-readiness checks and metadata schema work.                                           |
| `STORY-08` | Canonical E2E harness + failure-path checks          | `E4-F2-S1`               | Partial | `dispatch/logs/story_08_contract.md`            | Outbox→workflow failure-path coverage is the closest operationally equivalent anchor.                                                     |
| `STORY-09` | Structured logging + basic metrics                   | `E1-F2-S1`               | Partial | `dispatch/logs/story_09_contract.md`            | Trace propagation in vNext is broader; logging is part of observability contract now.                                                     |
| `STORY-10` | Dispatcher queue spec + tech packet surfaces         | `E7-F1-S1`               | Partial | `dispatch/logs/story_10_contract.md`            | vNext maps dispatcher workflow handoff into approval-signal and packet-oriented artifacts.                                                |
| `MVP-06`   | On-call runbook + operability readiness              | `E12-F1-S1`              | Partial | `dispatch/ops/runbooks/mvp_06_on_call_drill.md` | Operations/readiness content is now split from development contracts into runbook+operability artifacts.                                  |

## Update rule

- Add a row only when recurring legacy IDs are operationally ambiguous.
- When a legacy ID becomes unambiguous, set status to `Exact`, replace ambiguous notes with the canonical evidence, and retain legacy context for history.
