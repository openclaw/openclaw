# Malformed subagent output Wave 8 migration notes

Plan: `handoffs/framework/current/malformed-subagent-output-fix-plan-2026-05-16.md`

These notes apply to existing prose-only subagent tasks, dashboards, and historical views when malformed-child-output protections move from shadow/opt-in to enforced release candidates.

## Result state migration

- Treat legacy plaintext `PASS`, prose-only success claims, and schema-valid `PASS` without parent/runtime evidence as `UNVERIFIED`.
- Only `VERIFIED_PASS` may satisfy acceptance-gated work. `PASS` means the child claimed success; it is not enough by itself.
- `FAIL`, `MALFORMED`, `TIMEOUT`, `CANCELLED`, `INFRA_BLOCKED`, and `UNVERIFIED` remain non-success states for gate advancement.
- Dashboards must render `UNVERIFIED` as warning/validation-required, never as green success.

## Prose-only task migration

Existing tasks that currently end with prose should add a verdict artifact when they are acceptance-gated:

1. Write a strict JSON verdict artifact with `schemaVersion`, `verdict`, `changedPaths`, `sourcePaths`, `commandsRun`, and `outputArtifactPaths` or `outputArtifacts`.
2. Ensure every required artifact/log is independently observable by the parent/runtime.
3. Keep the final chat reply concise and refer to artifact IDs or repo-relative paths only.
4. Do not paste raw diffs, long logs, private paths, or raw child transcripts into final replies.

Read-only advisory agents may continue to produce prose, but their output stays advisory until verified evidence exists.

## Dashboard and session-history migration

- Store and display sanitized status cards: normalized state, contract verdict, acceptance eligibility, schema/verifier versions, opaque IDs, hashes, sizes, and reason codes.
- Exclude raw child bodies from dashboard summaries, session history/search/export, compacted context, and memory extraction.
- Show quarantine references as opaque artifact IDs plus payload hash/byte count only.
- Provide an operator raw-open affordance only through the isolated raw viewer. Do not preview snippets inline.
- On restart/resume, revalidate cached `VERIFIED_PASS` decisions against persisted evidence, current commit/scope, schema version, and verifier version. Downgrade to `UNVERIFIED` on mismatch or missing evidence.

## Operator impact

- Operators will see more validation-required results during rollout. That is intentional fail-closed behavior.
- The migration does not require live gateway config changes by itself.
- Rollback may disable acceptance enforcement only by degrading to `DIRECT_VERIFICATION_REQUIRED`; quarantine, compaction sanitation, and raw-output exclusion remain required.
