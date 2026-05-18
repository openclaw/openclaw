# Wave 8 canary and opt-in exit report

Date: 2026-05-18

## Exit status

Canary/opt-in exit is checker-ready for review. Enforcement must not advance
beyond opt-in until the attached replay, dashboard/session-history, threshold,
privacy, and rollback gates remain green.

## Canary scope

- Low-risk subagent workflows only.
- Metadata-only completion cards enabled.
- Acceptance enforcement enabled only for workflows with parent/runtime evidence
  available.
- Emergency raw-open remains isolated and explicit.
- No live gateway config was changed during Wave 8 rework.

## Exit criteria

- Zero raw child-body leaks into parent context, compaction, memory, dashboards,
  telemetry, git, or ordinary chat.
- Zero schema-valid `PASS` accepted without parent/runtime evidence.
- Replay corpus and golden/adversarial fixtures pass expected mappings.
- Dashboard/session-history compatibility sign-off complete.
- Rollback drill proves `DIRECT_VERIFICATION_REQUIRED` fail-closed behavior.
- Checker and mediator accept that only `VERIFIED_PASS` satisfies gates.

## Exit decision

Proceed to independent checker/mediator review, not default-on rollout. Default-on
requires the same evidence plus any repository-wide release gates designated by
the release owner.
