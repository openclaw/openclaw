# Malformed subagent output Wave 8 release-readiness record

Date: 2026-05-18
Plan: `handoffs/framework/current/malformed-subagent-output-fix-plan-2026-05-16.md`
Worktree: `openclaw-runtime-hardening-20260517`

## Verdict

Wave 8 is release-ready for independent checker and mediator review once the
operator-local primary report records green focused command evidence. The
release gate remains fail-closed: only `VERIFIED_PASS` with
parent/runtime-observed evidence can satisfy acceptance.

## Attached Wave 8 artifacts

- Canary/opt-in exit report:
  `docs/plan/malformed-subagent-output-wave8-canary-opt-in-exit-20260518.md`
- Replay corpus report:
  `docs/plan/malformed-subagent-output-wave8-replay-corpus-report-20260518.md`
  with metadata summary
  `docs/plan/malformed-subagent-output-wave8-replay-corpus-report-20260518.json`
- Dashboard/session-history sign-off:
  `docs/plan/malformed-subagent-output-wave8-dashboard-session-history-signoff-20260518.md`
- Wave 7 threshold results:
  `docs/plan/malformed-subagent-output-wave8-wave7-threshold-results-20260518.md`
- Security/privacy review:
  `docs/plan/malformed-subagent-output-wave8-security-privacy-review-20260518.md`
- Migration notes:
  `docs/plan/malformed-subagent-output-wave8-migration-notes-20260518.md`

## Result states

- `VERIFIED_PASS`: schema-valid report plus current parent/runtime evidence;
  this is the only state that may satisfy an acceptance gate.
- `FAIL`: explicit failing result or rejected gates; terminal non-success.
- `UNVERIFIED`: structurally usable but missing current parent/runtime proof.
- `MALFORMED`: missing schema, invalid schema, raw source/diff/log/grep,
  partial output, internal envelopes, empty output, or other non-report body.
- `TIMEOUT`: child did not complete within its timeout; partial output remains
  quarantined or metadata-only.
- `CANCELLED`: child was cancelled or killed; no acceptance evidence.
- `INFRA_BLOCKED`: dispatch/profile/tool/path capability mismatch; not a child
  verdict and not success.

`PASS`, `SCHEMA_VALID`, checker prose, mediator prose, green-looking chat, and
shadow-mode metrics are advisory only. They do not advance gates without
`VERIFIED_PASS`.

## Verdict artifact schema

Acceptance-gated children must write a strict JSON artifact before final chat.
The parent/runtime reads the artifact and verifies it independently.

Required semantic fields:

- `schemaVersion`: versioned child-result schema.
- `verdict`: `PASS`, `FAIL`, `REVISE`, or `BLOCKED` as the child claim.
- `outputArtifacts`: paths or opaque ids plus SHA-256 and byte counts.
- `commandsRun`: command ids/status/exit codes, with log ids or hashes.
- `changedPaths` and `sourcePaths`: scope for verifier comparison.
- `blockers`: explicit blockers for non-pass results.

The artifact may cite paths and hashes, but those citations are not trusted
until observed by parent/runtime evidence. Raw child output is never a valid
artifact field and must not be embedded in report JSON.

## Evidence verification requirements

A verifier may upgrade to `VERIFIED_PASS` only when all of these hold:

1. The artifact parses and matches the schema version.
2. Artifact, log, command, session, child run, and scope evidence were observed
   by `parent_runtime`, `checker`, or `mediator`, not child self-attestation.
3. Evidence ids, hashes, byte counts, and freshness match current files/logs.
4. Child run/session ids match; concurrent children cannot borrow evidence.
5. Reported changed/source paths are within parent-approved scope.
6. Stale process sweep is clean and attached to the same child identity.
7. Repo state is current when changed/source paths matter.
8. Rollback mode does not convert any advisory pass into success.

Failures surface as `EVIDENCE_UNVERIFIED` or another non-success state.

## Quarantine artifact lifecycle

Raw source, diffs, logs, grep dumps, internal envelopes, and partial bodies are
stored only in the OpenClaw-managed quarantine store, outside git, memory,
compaction, normal telemetry, dashboards, and ordinary chat.

Lifecycle invariants:

- opaque non-guessable artifact id, separate payload hash, and byte count;
- `0700` store directory and `0600` artifact/payload files, or platform
  equivalents;
- symlinks, hardlinks, traversal, and meaningful raw-derived filenames rejected;
- atomic writes with size/count/TTL quotas;
- metadata records include redaction summary and retention metadata only;
- cleanup is TTL/quota based, with explicit operator deletion by artifact id;
- if quarantine is unavailable, delivery degrades to metadata-only non-success;
- encryption-at-rest remains a documented threat-model exception until a
  platform-backed implementation lands.

## Operator raw-open workflow

Raw-open is not a chat, model, compaction, or dashboard preview path.
It requires an explicit local operator action:

1. Operator copies the opaque artifact id and payload hash from the status card.
2. CLI/UI displays a warning and asks for artifact/hash confirmation.
3. Authorization is checked locally.
4. A metadata-only audit event records who opened which artifact id/hash.
5. Raw payload is shown in an isolated viewer with no markdown, ANSI, HTML,
   snippet preview, first-lines preview, or raw-derived filename.
6. The raw body is never written back into parent context, ordinary chat,
   memory, telemetry, session history, or dashboards.

## Rollout and rollback

Rollout remains staged:

1. Stage 0: classify-only shadow mode; metrics are diagnostic.
2. Stage 1: replay corpus and golden/adversarial fixtures.
3. Stage 2: opt-in low-risk workflows after thresholds pass.
4. Stage 3: high-risk merge/destructive/external-action gates.
5. Stage 4: default-on after stability, compatibility sign-off, and rollback
   drill.

Rollback may disable acceptance enforcement only by degrading to
`DIRECT_VERIFICATION_REQUIRED`. It must not disable quarantine, compaction
sanitation, or raw-output exclusion. If those protections are unavailable, all
subagent-derived acceptance gates fail closed.

## Final integration coverage

Focused Wave 8 coverage added in
`src/agents/subagent-child-result-wave8-final-integration.test.ts` exercises:

- primary/checker/mediator `VERIFIED_PASS` chain;
- advisory schema-valid pass rejected as `EVIDENCE_UNVERIFIED`;
- restart/resume records keeping normalized result, raw quarantine reference,
  and verifier decision separate;
- concurrent child evidence/session cross-contamination rejection;
- rollback drill to `DIRECT_VERIFICATION_REQUIRED` while quarantine,
  sanitation, and raw-output exclusion remain required.

## Final checker evidence map

The checker should review:

- source map:
  `docs/plan/malformed-subagent-output-wave0-source-map-20260518.md`;
- rollout safety/threshold gates:
  `docs/plan/malformed-subagent-output-wave7-rollout-safety-20260518.md` and
  `docs/plan/malformed-subagent-output-wave8-wave7-threshold-results-20260518.md`;
- replay corpus fixture/report:
  `test/fixtures/malformed-subagent-output-wave7-replay-corpus.json`,
  `docs/plan/malformed-subagent-output-wave8-replay-corpus-report-20260518.md`,
  and `docs/plan/malformed-subagent-output-wave8-replay-corpus-report-20260518.json`;
- final-flow tests:
  `src/agents/subagent-child-result-wave8-final-integration.test.ts` plus the
  focused existing suites named in the final evidence logs;
- privacy/release artifacts listed above.

## Mediator evidence map

The mediator should confirm that every release-gate advancement path requires:

- normalized state `VERIFIED_PASS`;
- `acceptanceEligible: true`;
- parent/runtime evidence verifier decision `VERIFIED_PASS`;
- dashboard semantic success only for verified/eligible pass.

Schema-valid `PASS`, prose `PASS`, child-provided hashes, shadow-mode metrics,
and checker/mediator prose are explicitly insufficient.

## Release gates

Final recorded command evidence is attached to the operator-local Wave 8
primary report and includes:

- `git-diff-check.log`
- `wave8-final-integration.log`
- `focused-existing-suites.log`
- `package-session-sanitizer-suite.log`
- `tsc-wave8-test.log`
- `oxlint-wave8-test.log`
- `docs-format-wave8.log`
- `replay-report-json.log`
- `secret-privacy-scan.log`
- `rollback-drill.log`
- `final-stale-process-scan.log`

A release cannot advance if any log fails, if raw artifacts appear in git, or if
checker/mediator cannot independently verify that `VERIFIED_PASS` is the sole
success state.
