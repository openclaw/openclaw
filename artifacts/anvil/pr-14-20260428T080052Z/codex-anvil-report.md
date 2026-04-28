Summary

Reviewed PR #14 end to end from artifacts, diff, changed daemon, nearby config/schema, launch/run surfaces, and the paired BenchAGI web contract surface. No local repair was applied; the worktree is clean.

Vision

Phase D2.1 makes `cloud-mirror` tenant-aware: resolve a stable `instanceId`, mirror only that instance’s vault, keep mirror hash state isolated per instance, and stamp outbound ingest entries with `sourceInstanceId` so the web side can enforce tenant-scoped canon reads while preserving Tier A `main` fallback.

Acceptance Criteria

- Env override `BENCH_INSTANCE_ID` wins over config when valid.
- `~/.openclaw/openclaw.json.instanceId` is accepted only when it matches `[A-Za-z0-9_-]{1,128}`.
- With an instance id, the daemon watches `~/.openclaw/wiki/<instanceId>`, writes `~/.openclaw/state/wiki-mirror.<instanceId>.json`, logs the resolved id, and sends `sourceInstanceId`.
- Without an instance id, existing Tier A behavior remains `wiki/main`, `wiki-mirror.json`, and no `sourceInstanceId`.
- Ingest remains `POST { entries }` with existing `X-API-Key` auth behavior.
- Cloud ingest/read-side routes accept, persist, and enforce `sourceInstanceId`; current global/root canon semantics remain `null`.
- No billing, checkout, mobile UI, or Firestore rules are changed by this PR.
- At least a direct daemon syntax/smoke check proves the standalone `.mjs` behavior.

Verdict

WATCH

Findings

High, external rollout gate: `extensions/claude-code-bridge/cloud-mirror.mjs:212` now sends `sourceInstanceId`, so production safety depends on the BenchAGI web `/api/v1/wiki/ingest` route and read routes accepting and enforcing that field. I found a sibling BenchAGI web PR worktree that does accept/persist `sourceInstanceId` and filters reads, but the current checked-out BenchAGI web main still ignores the field. Do not enable this daemon path against production tenants until that web surface is merged/deployed/verified.

No local OpenClaw code defect found in the changed PR surface.

Repairs Attempted

None. No files edited; no repair patch was produced.

Verification

- Harness deterministic checks: skipped by `--no-checks`; there were no failed logs to classify.
- `node --check extensions/claude-code-bridge/cloud-mirror.mjs` passed.
- Isolated smoke with temp `HOME` and config `instanceId: "test-shard"` passed: daemon posted `sourceInstanceId: "test-shard"`, used `sourcePath: "test-shard/alpha.md"`, wrote `wiki-mirror.test-shard.json`, and did not write legacy `wiki-mirror.json`.
- Env override smoke passed: `BENCH_INSTANCE_ID=env-shard` overrode config and wrote `wiki-mirror.env-shard.json`.
- `git diff --check origin/feat/config-instance-id...HEAD` passed.
- `node scripts/check-no-conflict-markers.mjs` passed.
- One non-counted command, `node scripts/tool-display.ts --check`, failed because I used the wrong TS entrypoint without the repo loader/deps; this is not PR-caused.

Remaining Risks

The main remaining risk is rollout ordering: if OpenClaw ships first and a tenant daemon posts to an older web route, `sourceInstanceId` may be ignored and entries can remain/globalize as root canon.

Recommended Repair Pass

No local OpenClaw repair pass needed. Before final ship, verify the paired BenchAGI web ingest/read-side PR is landed and deployed, then run one live or staging ingest with `BENCH_INSTANCE_ID=test-shard` and confirm the stored wiki entry has `sourceInstanceId: "test-shard"` and cross-tenant reads return 404.

Handoff

PR-specific local evidence is clean. Keep PR #14 in WATCH until the named external web surface is verified; after that, it can proceed through the normal ship path.
