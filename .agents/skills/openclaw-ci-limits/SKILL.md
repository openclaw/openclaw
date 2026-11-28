---
name: openclaw-ci-limits
description: "Diagnose OpenClaw CI queues and runner capacity, or tune workflow fanout, registration budgets, and runner placement."
---

# OpenClaw CI Limits

Use this skill for CI capacity changes, not ordinary test failure triage. The
goal is to keep OpenClaw fast while distinguishing runner registration, runner
availability, provider control-plane health, and downstream queue drains.

Read [backend selection](references/backend.md) and
[investigation](references/investigation.md) before changing capacity. Confirm
the actual runner and bottleneck before applying provider-specific limits.

## Core Facts

- Full main-tier CI runs hourly; ordinary main pushes run `security-fast`.
  A green push is not evidence that the full suite passed. Ordinary PRs defer
  Windows, macOS Node/Swift, iOS build/simulator, real-Gateway UI, published-driver
  update, Knip, and most architecture proof. Import-cycle and Kysely guards
  remain blocking. Use `docs/ci/scope-and-routing/selection.md` and the current
  manifest for exact event, owner, and release-fallback selection; do not restore
  deferred lanes while tuning capacity. Android screenshots remain release-only.
- Do not assume the scarce resource. Prove whether pressure is runner
  registrations, eligible runner availability, Blacksmith capacity/control
  plane, workflow dependencies, test runtime, or a downstream queue writer.
- GitHub runner registrations for `openclaw` currently report a 10,000 per
  5-minute bucket in `actions_runner_registration`. Verify the live bucket
  before each tuning pass because GitHub can change it. The `openclaw`
  organization shares one bucket.
- Core REST quota does not draw down this bucket. Check
  `actions_runner_registration` separately; core quota can be healthy while
  runner registration is throttled.
- Use about 60% of the live bucket as the operating target. With the current
  10,000-registration bucket, keep planned Blacksmith burst load under 6,000
  registrations per 5 minutes and leave the rest for other repos, retries, and
  burst overlap.
- Jobs that route, notify, summarize, choose shards, or run short CodeQL quality
  scans should stay on GitHub-hosted runners unless measured evidence says
  Blacksmith is required.

## Runner Cost Policy

- Use the smallest runner that completes the required workload reliably. Keep
  short control jobs hosted and ordinary trusted development proof local.
- Treat physical 8-vCPU and larger runners as exceptions, not a default or generic retry. Record the
  command and measured peak memory, a smaller-runner OOM, or a controlled
  comparison showing lower total billed cost. Low CPU use alone does not prove
  a memory-heavy job can move down. Preserve resource-based worker limits.
- Routine OpenClaw Testboxes use the 4-class with a 60-minute total-job
  default, including hydration. Keep the 15-minute idle ceiling. Shorter
  deadlines are welcome for known short commands; do not request four hours
  automatically or upsize only to obtain more time. Select
  `.github/workflows/ci-check-high-memory-testbox.yml` explicitly only for a
  named memory-heavy command; see `docs/reference/test/remote-proof.md`.
  That workflow has at most four concurrent leases inside the shared 32-slot
  Testbox pool. The high-memory profile uses 8 vCPUs; both profiles preserve
  their pre-November 3 physical CPU and RAM. All Testbox profiles cap idle time at 15 minutes.
- Allocate through the current OpenClaw wrapper with workflow ref `main`;
  the source capsule preserves the checkout being tested. Do not dispatch an
  old workflow ref to bypass spending limits. Queue age is checked before
  checkout; an admitted lease keeps its job and idle deadlines.
- Do not promote an entire workflow family because one command needs more RAM.
  Keep proven high-memory CI rows scoped to their owning planner and evidence;
  remeasure before changing their allocation. A 32-class label is not proof of
  32 available CPUs. Compare observed resources and total billed job cost.

## Select the affected controls

Read only the references relevant to the selected change, each in full:

| Surface                                                      | Guide                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| Hosted controls, lint/typecheck placement, backend overrides | [Control jobs](references/control-jobs.md)             |
| Build producers, warming, compile caches, locale sharing     | [Build and cache](references/build-and-cache.md)       |
| Matrix coverage, platform tests, UI, Docker, QA              | [Test planning](references/test-planning.md)           |
| Compact bins, worker budgets, measured runner sizing         | [Packing and sizing](references/packing-and-sizing.md) |
| SDK boundary and API checks                                  | [Compiler checks](references/compiler-checks.md)       |
| Reconsidering a previous optimization                        | [Rejected experiments](references/experiments.md)      |
| Checking a change and observing a landed capacity change     | [Validation](references/validation.md)                 |

## Resolve the active backend

Read [Resolve the active backend](references/backend.md#resolve-the-active-backend).

## Rejected Experiments

Read [Rejected Experiments](references/experiments.md#rejected-experiments).

## First Checks

Read [First Checks](references/investigation.md#first-checks).

## Diagnose The Bottleneck

Read [Diagnose The Bottleneck](references/investigation.md#diagnose-the-bottleneck).

## Registration Budget Math

Read [Registration Budget Math](references/investigation.md#registration-budget-math).

## Safe Levers

Read [Safe Levers](references/investigation.md#safe-levers).

## Current OpenClaw Knobs

These are intentionally guarded by the `ci-workflow-guards`,
`ci-workflow-planning`, and `ci-workflow-evidence` tests under `test/scripts/`:

Use the surface table above. When changing one knob, update `docs/ci.md` and the guard test in the same PR.

## Provider Outage Circuit Breaker

Read [Provider Outage Circuit Breaker](references/backend.md#provider-outage-circuit-breaker).

## Validation

Read [Validation](references/validation.md#validation).

## Post-Land Monitoring

Read [Post-Land Monitoring](references/validation.md#post-land-monitoring).
