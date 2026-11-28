# Control jobs

- `CI` concurrency key version, PR cancellation, and canonical `main`'s two
  non-canceling parity slots, each with one coalesced pending tip.
- Ordinary canonical same-repository hybrid first attempts keep `preflight`,
  `pr-failure-report`, and `ci-gate` on hosted Ubuntu. October 15's 26-PR sample
  found 148 minutes of Blacksmith preflight queueing, with a 12.9-minute p75.
  RunsOn and admitted qualification/release dispatches
  retain their existing routes. Count these mandatory hosted controls before
  optional offload; keep the 45-row ceiling and all job/worker limits.
  Core lint uses the 16-class on canonical automatic first attempts with an
  unset, `blacksmith`, or `hybrid` backend, excluding fork PRs. Admitted
  qualifications retain their existing routes. The first packed lint row took
  621s on the 8-class; retain four
  actual CPUs for that row. The second packed row later exceeded its existing
  15-minute limit on the 8-class, so it uses the same 16-class. This adds no
  jobs or registrations and keeps the deadline and complete stripe inventory. The gate has no checkout or dependency setup; retries, ordinary
  manual dispatches, noncanonical contexts, and the GitHub override stay hosted.
  Core lint additionally retains hosted routing for frozen targets. Normal hybrid
  main/same-repository PRs add two lint assignments within the reserved
  84-row non-Node allowance in [registration budget math](investigation.md#registration-budget-math).
  Automatic canonical RunsOn first-attempt `preflight` uses
  the existing 4-class, matching default Blacksmith preflight. The former 16-class
  placement addressed hosted queue stalls. October 13 observations found 610
  4-class runs with no OOMs and 113s p95 duration; full and changed manifest plans
  also fit two CPUs and 4 GiB without swap with unchanged outputs. Keep the
  logical planner profile, cache trust, and 20-minute deadline. Hybrid/RunsOn
  retries, manual dispatches, noncanonical contexts, and the `github` override
  retain hosted routing. Monitor assignment latency before claiming rollout savings.
  `security-fast` stays hosted
  outside eligible hybrid first attempts and when the bounded hosted plan is admitted. Security hooks use pinned installed packages
  and local hook definitions, without remote Git initialization. The `github`
  outage override remains intact. Ordinary same-repository hybrid controls add
  at most one Blacksmith security registration when optional hosted admission is
  closed, none when admitted. Normal Blacksmith runs retain their existing
  control registrations within the reserved non-Node inventory.
  Selected baseline ratchets and Node rows start independently after preflight.
  Keep the standalone ratchet owner and exact merge-parent/base checks; the final
  gate still requires every selected ratchet to pass. Same-repository
  hybrid first attempts use the existing 4-class for the ratchet job, with its
  measured 91-second bound adding at most 6.07 class-vCPU-minutes and no jobs.
  Preserve the existing hosted fallbacks and deadline.
  The existing `check-plan` prerequisite uses the 16-class for shared compiler
  snapshot memory on canonical automatic first attempts with an unset,
  `blacksmith`, or `hybrid` backend, excluding fork PRs. Same-repository hybrid
  PR first attempts instead use hosted planning with the existing serial
  compiler discovery mode; reserve that mandatory row before optional offloads.
  Never move the complete compiler snapshot onto the smaller hosted runner.
  Hybrid health admission retains its existing placement rules. These routes
  add paid assignments, not jobs. Preserve logical GitHub stripe coverage,
  restore-only PR caches, and same-repository cache trust. The GitHub override,
  retries, ordinary manual and frozen targets, RunsOn planners, and noncanonical
  contexts retain hosted planning. Admitted qualification dispatches keep their
  existing routes. Fork standalone ratchets stay hosted. See
  `docs/ci/runners.md` for the current routing and `docs/ci/routing-costs.md`
  for measured latency and cost; older 4-class planner estimates no longer apply.
  Optional compiler/check offloads reject observed hosted assignment waits at
  sixty seconds; the former three-minute cutoff exceeded the latency objective.
  API and job deadlines remain unchanged.
  PR jobs finish after sibling failures. `pr-failure-report` waits for the
  planned jobs and reuses `ci-known-main-red.mjs` to classify each failed or
  timed-out job against the newest completed scheduled main CI run. Matching
  job names/shards and supported failure signatures are pre-existing; a main
  pass or different signature is new; missing jobs or evidence are unknown.
  Job-name-only matches are labeled in the reason; check their failing tests
  against main before attributing the failure.
  Its table and JSON output reach `openclaw/ci-gate`; the existing gate result
  and known-main-red allowance stay unchanged. Superseded-run cancellation,
  runner routes, concurrency and fanout caps remain unchanged. The report
  consumes one existing non-Node reserve slot: the 71-row union
  leaves thirteen inside the unchanged 84-row allowance and 5,110 bound.

- Automatic canonical hybrid first attempts count every selected hosted row in
  preflight. `HYBRID_HOSTED_BASE_ROW_LIMIT = 40` admits at most two optional
  rows within `HYBRID_HOSTED_ROW_LIMIT = 45`: security and browser-extension
  E2E. Control UI unit rows retain the 8-class on eligible first attempts.
  Above 40 base rows, retain the optional rows' existing
  Blacksmith routes; an eligible base above 45 warns with counts and retains
  the complete base manifest. The budget limits optional admission, not coverage.
  Record base/total rows and compare the actual workflow expansion in guards.
  This never expands test coverage or workers; Control UI E2E shards, QA,
  real-Gateway, Android, and compiler-heavy jobs retain their existing routes.
  Frozen/manual targets, retries and fully hosted fallback
  manifests remain outside this first-attempt limit, including existing >45-row
  fallbacks. Do not change the backend variable or existing caps to enable it.
- Full hybrid check plans may share central formatting and scripts lint with
  existing core lint stripe 1 when its full command inventory contains only those
  commands. Retain both original core stripes, the exact central selection and
  changed paths, sequential execution, one lint thread and the 15-minute budget.
  UI, root-test and wrapper guards keep their separate central row. Require
  another remaining check row for the existing gate; targeted and other runner
  profiles retain their layout. Run shared central lint after a core failure so
  its diagnostics and failure remain visible. This removes one registration and
  setup, without enlarging runner capacity or relaxing a check.
- Current GitHub/hybrid test types use five canonical core stripe jobs plus
  the central extensions/scripts/root tail. Eligible core-change PRs keep the
  same rows: each validates the complete graph boundary and intersects selected
  consumers with its original stripe. Empty intersections stay empty; ambiguous
  selection falls back to every canonical graph across those same stripes.
  Check existence only for compiler inputs: deleted Markdown and UI CSS paths
  do not widen accompanying code changes; deleted compiler inputs retain full coverage.
  Frozen targets retain two paired rows for stripes 1+2 and 3+4 sequentially,
  with stripe 5 in the central row. Keep at most two compiler children per
  stripe and one builder per child. A failing stripe stops its row; other
  matrix rows keep running. Pure Blacksmith and targets without stripe support
  retain the central path. Keep row caps and deadlines unchanged; measure actual
  hosted completion rather than inferring wall-time savings from partitioning.
- CPU-heavy test-type, core test-type stripe, and runtime-topology jobs in `ci.yml`
  request `blacksmith-16vcpu-ubuntu-2404`. The separate `openclaw-npm-preflight.yml`
  jobs retain `blacksmith-32vcpu-ubuntu-2404`. The 2026-09-01 x64 probe
  [run 33538827388](https://github.com/openclaw/openclaw/actions/runs/33538827388)
  measured requested 8/16/32 labels delivering 2/4/8 CPUs respectively. Treat
  larger requests as a measured capacity workaround, never as worker counts.
  Keep existing routing, fanout, and resource-based worker limits; reassess
  sizing after provider allocation changes. See `docs/ci.md` for the full table.
- CodeQL Critical Quality on `ubuntu-24.04` with no `blacksmith-` labels.
- Where repository variables are available, `OPENCLAW_CI_RUNNER_BACKEND=github`
  routes configurable `ci.yml` jobs to their existing GitHub-hosted fallback
  labels. Unset or `blacksmith` preserves the normal Blacksmith-first route.
  Canonical fork PRs use the GitHub profile and hosted runners on every attempt,
  even when repository variables are unavailable. Their cache trust stays
  unchanged.
