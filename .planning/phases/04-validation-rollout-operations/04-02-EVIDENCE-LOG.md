# Phase 04 Plan 02 Evidence Log

Date started: 2026-03-08  
Run ID: `phase04-plan02-20260308`

## Per-Scenario Log

| Scenario | Preconditions | Command/Trigger | Expected | Observed | Telemetry check | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P04-S01 | off mode policy fixture | `pnpm test extensions/frankos-governance/index.test.ts` | permit | off-mode mutating action returned `undefined` | governance diagnostics not emitted in off mode | pass | test: "off mode permits mutating actions without governance diagnostics" |
| P04-S02 | shadow mode policy fixture | `pnpm test extensions/frankos-governance/index.test.ts` | prohibit observed, execution allowed | shadow test passed | governance.decision validated in unit assertions | pass | test: "shadow mode allows prohibited action and emits governance telemetry" |
| P04-S03 | enforce mode policy fixture | `pnpm test extensions/frankos-governance/index.test.ts` | prohibit enforced | enforce prohibit + fail-closed tests passed | decision + reason assertions passed | pass | includes missing policy fail-closed case |
| P04-S04 | enforce mode escalation fixture | `pnpm test extensions/frankos-governance/index.test.ts` | escalate/prohibit | escalation-required action test passed | reason code asserted | pass | stable reason prefix verified |
| P04-S05 | shadow+enforce fixtures | `pnpm test extensions/frankos-governance/index.test.ts` | deterministic reason codes | stable reason prefix tests passed | reasonCode assertions passed | pass | requires live cross-mode replay for final gate |
| P04-S06 | shadow memory fixture | `pnpm test extensions/frankos-memory-governance/index.test.ts` | memory governance observed | shadow provenance/inference tests passed | memory.governance.decision emitted | pass | validation_failure event emitted in shadow case |
| P04-S07 | enforce memory fixture | `pnpm test extensions/frankos-memory-governance/index.test.ts` | invalid provenance blocked | enforce provenance/inference block tests passed | enforce decision telemetry asserted | pass | includes classification/inference-basis checks |
| P04-S08 | correction fixture | `pnpm test extensions/frankos-memory-governance/index.test.ts` | correction + supersession event | supersession test passed | memory.correction.supersession asserted | pass | correction linkage validated |
| P04-S09 | telemetry fixtures | `pnpm test extensions/frankos-governance/index.test.ts extensions/frankos-memory-governance/index.test.ts` | required diagnostics fields present | diagnostics assertions passed | mode/decision/reasonCode fields covered | pass | add live event payload capture before promotion |
| P04-S10 | OTEL fixture | `pnpm test extensions/diagnostics-otel/src/service.test.ts` | OTEL mapping present | service OTEL test passed | governance+memory counters/histograms/spans asserted | pass | collector endpoint not required for unit pass |
| P04-S11 | enforce+shadow fixtures with same policy/action | `pnpm test extensions/frankos-governance/index.test.ts` | enforce->shadow rollback safe | enforce blocked; shadow allowed same action | shadow governance telemetry emitted with `decision=prohibit` | pass | test: "rollback scenario enforce->shadow relaxes enforcement for same prohibited action" |
| P04-S12 | shadow+off fixtures with same policy/action | `pnpm test extensions/frankos-governance/index.test.ts` | shadow->off rollback safe | shadow observed decision; off returned passive allow | off mode emitted no governance telemetry | pass | test: "rollback scenario shadow->off restores passive baseline for same prohibited action" |

## Aggregate Summary
1. Total scenarios: 12
2. Pass: 12
3. Fail: 0
4. Blocked: 0
5. Pending: 0
6. Blocking defects: none from executed evidence
7. Rollback readiness: yes (scenario evidence captured for both rollback paths)
8. Promotion recommendation: ready for human gate review; recommend canary-first promotion
