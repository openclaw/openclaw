# Phase 06 Test Suites (L031-L033)

Date: 2026-03-08  
Status: defined

## L031: Memory Test Suite
Suite id: `MEM`

Coverage targets:
1. Memory provenance enforcement (missing provenance handling).
2. Inferred-vs-observed validation.
3. Classification and confidence guardrails.
4. Fail-closed behavior when policy evaluation fails.

Primary test target:
1. `extensions/frankos-memory-governance/index.test.ts`

Pass criteria:
1. All tests in target file pass.
2. Expected memory governance decision paths are asserted.

## L032: Continuity Test Suite
Suite id: `CON`

Coverage targets:
1. Governance mode continuity across transitions (`enforce -> shadow -> off`).
2. Stable reason code behavior across repeated calls.
3. No stale blocking behavior after rollback transitions.

Primary test target:
1. `extensions/frankos-governance/index.test.ts`

Pass criteria:
1. All tests in target file pass.
2. Rollback transition scenarios pass without regressions.

## L033: Contradiction Test Suite
Suite id: `CRT`

Coverage targets:
1. Contradictory memory states resolved via correction/supersession.
2. Provenance validation failure emits explicit contradiction signal path.
3. Telemetry export preserves contradiction-relevant attributes and spans.

Primary test targets:
1. `extensions/frankos-memory-governance/index.test.ts`
2. `extensions/diagnostics-otel/src/service.test.ts`

Pass criteria:
1. All tests in target files pass.
2. Supersession and provenance-failure telemetry assertions pass.
