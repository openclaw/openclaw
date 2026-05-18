# Wave 8 attachment: Wave 7 threshold results

Date: 2026-05-18
Source: `docs/plan/malformed-subagent-output-wave7-rollout-safety-20260518.md`

## Declared thresholds before Stage 2+

All Stage 2+ rollout thresholds are declared before enforcement:

- raw child-body leak count: zero;
- schema-valid `PASS` accepted without parent/runtime evidence: zero;
- golden/adversarial fixture pass rate: 100%;
- compatibility regressions for cron, announce, dashboard, session history,
  search/export, and restart/resume: zero;
- replay corpus outcomes match expected normalized states;
- shadow baseline collected;
- rate thresholds approved from shadow baseline for downgraded-pass rate,
  malformed-classification rate, quarantine growth rate, and false-positive
  unverified/malformed rate.

## Wave 7 gate status

Wave 7 rollout logic includes tests for:

- shadow-mode telemetry as diagnostic only;
- metadata-only telemetry and parser-error records;
- replay corpus and golden/adversarial fixture outcomes;
- threshold evaluation before Stage 2+ claims;
- fail-closed rollback to `DIRECT_VERIFICATION_REQUIRED`;
- dashboard status and compatibility matrix mappings.

## Release attachment

The final Wave 8 primary report records the threshold test run and dedicated
rollback drill as operator-local command evidence.
