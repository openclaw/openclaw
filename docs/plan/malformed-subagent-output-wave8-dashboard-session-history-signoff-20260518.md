# Wave 8 dashboard and session-history compatibility sign-off

Date: 2026-05-18

## Sign-off verdict

Dashboard and session-history compatibility is ready for checker review when the
focused existing suites remain green. Rendering semantics distinguish
`UNVERIFIED` from success and preserve raw-output exclusion.

## Required behavior

- `VERIFIED_PASS` plus acceptance eligibility is the only success state.
- `UNVERIFIED` and `EVIDENCE_UNVERIFIED` render as warning/validation required.
- `MALFORMED` renders as quarantined/error metadata.
- Duplicate completions render as suppressed duplicate metadata.
- Session history, search, export, and memory surfaces retain sanitized metadata
  only.
- Raw-open requires explicit local operator action and is not a dashboard
  preview.

## Covered surfaces

- Internal task completion status card contract.
- Announce direct/queued/fallback delivery metadata.
- Session-history projection and memory-host session file sanitation.
- Compaction successor transcript sanitation.
- Telemetry/dashboard status rendering.

## Evidence logs

- `wave8-final-integration.log`: final primary/checker/mediator and rollback
  integration semantics.
- `focused-existing-suites.log`: child-result contract, sanitizer/privacy,
  announce/status, and rollout/replay suites.
- `secret-privacy-scan.log`: raw body and sensitive path exclusion checks.
