## First Checks

Before changing CI, collect current pressure:

```bash
gh api rate_limit --jq '{core:.resources.core,graphql:.resources.graphql,search:.resources.search,actions_runner_registration:.resources.actions_runner_registration}'
gh run list -R openclaw/openclaw --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
gh run list -R openclaw/clawsweeper --limit 20 --json databaseId,status,conclusion,workflowName,event,headBranch,createdAt,updatedAt,url
gh api repos/openclaw/clawsweeper/actions/runs/<run-id>/jobs --paginate --jq '.jobs[] | {id,name,status,conclusion,labels,created_at,started_at,completed_at,runner_name,runner_group_name}'
blacksmith testbox list --all
curl -fsS https://clawsweeper.openclaw.ai/api/status | jq '{generated_at,fleet,diagnostics:{errors:.diagnostics.errors}}'
curl -fsS https://clawsweeper.openclaw.ai/api/exact-review-queue | jq '{generated_at,review:.lanes.review,publication:.lanes.publication,state_writer,state_append}'
node scripts/ci-run-timings.mjs --latest-main
node scripts/ci-run-timings.mjs --recent 10
```

For a suspicious queued run, inspect its jobs. A run-level `queued` status does
not reveal whether the job is waiting on dependencies or has no eligible
runner. Compare `created_at`, `started_at`, `labels`, and `runner_name`. Recheck
stale queued runs live before canceling them; cancel only runs proven obsolete.

Testbox `warmup` confirms lease creation, not runner readiness. An initial
`queued` snapshot without `providerMetadata.runURL` does not establish a capacity
shortage. Use that URL to inspect the exact workflow once associated. An assigned
`check` runner performing setup is hydration; a confirmed admission or capacity
queue follows the existing stop-owned-allocation policy. Do not infer association
from the newest workflow run or wait on a confirmed capacity queue.

`scripts/ci-run-timings.mjs` start delay can include workflow dependency wait
plus runner queue time. It is trend evidence, not runner-pressure proof alone.

Read:

- `.github/workflows/ci.yml`
- `.github/workflows/codeql-critical-quality.yml`
- `docs/ci.md`
- `test/scripts/ci-workflow-guards.test.ts`
- `test/scripts/ci-workflow-planning.test.ts`
- `test/scripts/ci-workflow-evidence.test.ts`
- touched planner files under `scripts/lib/*ci*`, `scripts/lib/*test-plan*`, or
  `scripts/ci-changed-scope.mjs`

## Diagnose The Bottleneck

Classify the issue before changing caps:

- **Runner-registration throttle:** many jobs queued before runner assignment,
  Blacksmith/GitHub reports 403/429 or spam-style 422 responses from
  `generate-jitconfig`, and API core quota is still healthy. Treat 422 as this
  signal only when the request payload is otherwise valid. Fix burstiness and
  Blacksmith job count.
- **Blacksmith capacity:** Blacksmith dashboard shows actual concurrency caps or
  unavailable capacity. Do not solve this with GitHub workflow fanout alone.
- **Blacksmith Testbox control plane:** list, warm, status, or run calls time out
  before a lease is returned. This is separate from Actions runner registration
  and Actions job capacity. Trusted source may use the documented local
  fallback; untrusted source stays blocked.
- **Unavailable runner label:** a job is queued with a custom `runs-on` label,
  `started_at` and `runner_name` remain empty, and no eligible runner exists.
  Restore an available hosted or registered label; fanout cannot fix it.
- **Workflow dependency wait:** the job is queued but required predecessors are
  not terminal. Fix or wait for the dependency; do not call the whole delay
  runner queue pressure.
- **OpenClaw test runtime:** jobs start quickly but one lane dominates wall time.
  Use `$openclaw-test-performance` instead of runner tuning.
- **Real failing CI:** one job fails after starting. Use `$github:gh-fix-ci` or
  `$openclaw-testing`, not this skill.
- **ClawSweeper review backlog:** review pending/ready grows while publication
  and state writers remain healthy. Tune review admission/workers in
  `openclaw/clawsweeper`.
- **ClawSweeper publication backlog:** publication pending/ready and oldest age
  grow, net drain is zero or negative, or dead letters rise. Inspect publication
  batches, state-writer coordination, and GitHub mutation latency first.
- **State materializer/append backlog:** `state_append.pending_rows`,
  `pending_bytes`, or oldest age grows while the materializer is queued or
  absent. Recover that sole drain first; more review workers make it worse.

## Registration Budget Math

Estimate worst-case registrations for a change before editing:

```text
new Blacksmith registrations ~= number of Blacksmith jobs that can become queued
inside one 5 minute window
```

For matrix jobs, count every row that can start in the 5-minute window.
`strategy.max-parallel` only caps simultaneous rows; short rows can turn over
and register more runners before the window resets. Use job duration, retries,
and queue turnover to justify any lower estimate. Add non-matrix Blacksmith jobs
such as `preflight`, `security-fast`, `build-artifacts`, and platform lanes.

For repeated pull-request pushes, multiply by the number of runs expected to
reach Blacksmith admission in the same 5-minute window, including runs canceled
after admission. Canonical `main` uses two run-number-parity slots. Each slot
keeps one active non-canceling run and one coalesced pending tip. Budget for up
to two active main matrices plus their two pending tips entering the next
admission wave, not every intermediate merge.

Reject a change unless the org-level worst case stays below about 60% of the
live bucket. With the current 10,000-registration bucket, keep planned
Blacksmith burst load under 6,000 registrations per 5 minutes with headroom for
ClawSweeper, ClawHub, Clownfish, OpenClaw RTT, and Clawbench.

Native compact plans admit 90 rows and GitHub-hosted plans 96; final Node caps remain 70 push and 130 PR rows.
The historical automatic main/PR inventory had 71 potentially
self-hosted non-Node rows, including five core-lint stripes for fork PRs,
five type stripes, five Windows rows, and thirteen UI E2E rows. Retain an 84-row
allowance with thirteen rows reserved: `4 × 154 + 21 × 214 = 5,110` for the
four-main/21-PR arrival envelope, leaving 890 below the 6,000 reference target.
The six extension-lint rows remain hosted. Manual/frozen releases and other
workflows are outside this envelope. This is conditional planning, not live
organization-wide capacity proof; older 5,010/5,085/5,160 examples in [test planning](test-planning.md) describe
historical inventories and do not replace this reserve. Recount actual selected
runners for a new tuning pass; fork rows now run hosted.

## Safe Levers

Prefer these in order:

1. Preserve cancel-in-progress for superseded pull-request heads.
2. Preserve canonical `main` as two non-canceling parity slots; each slot's
   default pending run coalesces to the newest tip.
3. Move high-frequency, short, non-build jobs to `ubuntu-24.04`.
4. Reduce matrix rows by bundling related tests inside one runner job when the
   combined job stays under timeout and keeps useful failure names.
5. Lower `strategy.max-parallel` for bursty Blacksmith matrices.
6. Right-size runners from timing evidence. Use fewer/larger jobs only when
   elapsed time improves enough to justify registration count.
7. Split truly slow tests with `$openclaw-test-performance`; do not hide a slow
   test problem by registering more runners.

Do not:

- add another Blacksmith installation expecting a higher registration bucket;
- move CodeQL Critical Quality back to Blacksmith;
- raise all `max-parallel` values at once;
- make manual `workflow_dispatch` runs cancel normal push/PR validation;
- delete coverage just to reduce runner count;
- treat cancelled superseded pull-request runs as failures without checking the
  newest run for the same ref.
- cancel old queued runs from a stale snapshot; re-query the exact run first and
  preserve any current run that still owns live work.
