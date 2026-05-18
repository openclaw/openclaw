# Malformed subagent output Wave 7 rollout safety

Plan: `handoffs/framework/current/malformed-subagent-output-fix-plan-2026-05-16.md`

Wave 7 adds non-gating rollout instrumentation around the existing child-result parser, classifier, quarantine store, evidence verifier, and status-card delivery path. Shadow-mode output is diagnostic only until the replay, fixture, compatibility, and stage-threshold gates below pass.

## Shadow-mode verifier

`src/agents/subagent-child-result-rollout.ts` provides a shadow verifier that runs the same parser/classifier/evidence verifier as the enforced path and emits metadata-only telemetry. It does **not** change the existing workflow gate in shadow mode:

- `gatingDecision: "not_applied_shadow_mode"`
- `existingWorkflowGateUnchanged: true`
- `displayableAsSafetyProof: false` unless replay and threshold gates are satisfied

Shadow counters alone must never be presented as proof of safety.

## Metadata-only telemetry invariant

Telemetry, app logs, debug logs, traces, metrics, parser errors, crash reports, dashboards, and replay summaries may include only metadata:

- normalized state, verdict labels, delivery labels, and schema/verifier versions
- opaque ids, hashes, byte sizes, counts, retry counts, and booleans
- parent-observed evidence decisions and reason codes

They must not include payload snippets, parse-failure input, sampled bodies, raw child output, raw local paths, or raw quarantine filenames. Parser-error telemetry stores failed-input hashes and byte counts only.

Tracked counters:

- malformed outputs
- downgraded passes
- evidence verification failures
- schema versions
- quarantine classes
- duplicate suppressions
- profile mismatch blocks

Rate dimensions:

- worker mode
- issue/task type
- agent profile
- task label hash
- output class
- prompt/context token size
- child output size
- file count/bytes read
- file count/bytes touched
- log bytes
- retry count
- source-heavy/test-heavy flags
- verdict artifact required yes/no

## Rollout stages

| Stage | Mode                        | Feature flags                                                                                           | Gate semantics                                              |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0     | classify-only shadow        | `classifyOnlyShadow=true`, `acceptanceEnforcement=false`, `uiRendering=false`, `emergencyRawOpen=false` | Metrics only; no workflow changes.                          |
| 1     | replay + fixtures           | shadow classification plus named replay corpus                                                          | Metrics remain non-proof until corpus expectations pass.    |
| 2     | opt-in low-risk enforcement | `acceptanceEnforcement=true`, `uiRendering=true`, raw-open isolated only                                | May advance only after thresholds below are satisfied.      |
| 3     | high-risk enforcement       | Stage 2 plus merge/destructive/external-action gates                                                    | Only parent/runtime `VERIFIED_PASS` can satisfy acceptance. |
| 4     | default-on                  | default enforcement after stability window and rollback drill                                           | Raw output remains excluded by default.                     |

Emergency raw-open behavior is an isolated raw viewer only. Raw child output is never reintroduced into ordinary chat, model context, compaction, search/export, or shared channels.

## Stage 2+ advancement thresholds

These thresholds are declared before Stage 2 and all must be satisfied before Stage 2 or later rollout:

- zero raw body leaks
- zero schema-valid `PASS` accepted without parent/runtime evidence
- 100% golden/adversarial fixture pass rate
- zero known cron, announce, dashboard, session-history/search/export, and restart/resume regressions
- replay corpus outcomes match expected normalized states
- shadow baseline collected
- rate thresholds approved from the shadow baseline for downgraded-pass rate, malformed-classification rate, quarantine growth rate, and false-positive unverified/malformed rate

## Named replay corpus

The Wave 7 replay corpus lives at `test/fixtures/malformed-subagent-output-wave7-replay-corpus.json` and is extended in tests with generated golden/adversarial fixtures. Expected mappings cover:

- polluted sessions
- clean prose-only legacy agents
- read-only auditor completions
- timeout/cancelled children
- cron/background tasks
- direct and queued announcements
- dashboard/session-history views
- restart/resume cases
- golden verified-pass parent evidence
- adversarial raw diff/source output

Replay reports include input hashes and byte counts only; fixture bodies do not appear in telemetry or dashboards.

## Compatibility mapping

| Consumer                      | Compatibility behavior                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Legacy prose-only agents      | Plain prose or plaintext `PASS` maps to `UNVERIFIED`/`DIRECT_VERIFICATION_REQUIRED`; it is not green/success.         |
| Cron/background flows         | Completion is metadata-only until run-scoped parent evidence verifies the result.                                     |
| Direct announcements          | Delivered status card contains verified summary metadata or validation-required metadata; raw body is excluded.       |
| Queued announcements          | Queue payloads carry hashes, labels, sizes, and state only; raw child body is not replayed later.                     |
| Dashboards                    | `UNVERIFIED` renders as warning; only `VERIFIED_PASS` plus acceptance eligibility renders as success.                 |
| Session history/search/export | Views use sanitized metadata only; raw quarantined child output is excluded unless opened in the isolated raw viewer. |
| Restart/resume                | Cached child `PASS` must be revalidated or downgraded to `UNVERIFIED`/`DIRECT_VERIFICATION_REQUIRED`.                 |
| Read-only auditors            | Auditor prose is advisory only until parent/runtime evidence verifies artifacts and logs.                             |

## Kill switch and rollback

Rollback may disable acceptance enforcement only by failing closed to `DIRECT_VERIFICATION_REQUIRED`. Rollback must not disable:

- quarantine
- compaction sanitation
- raw-output exclusion

If any of those required protections are unavailable, rollout mode also fails closed to `DIRECT_VERIFICATION_REQUIRED`. Raw child output remains excluded unless explicitly opened by a local operator in the isolated raw viewer.
