# OpenClaw Upstream Contribution Plan

## Purpose

The local build-factory stack cannot be pushed upstream as a normal branch.
The local history contains older private/runtime artifacts that GitHub push
protection rejects, and `upstream/main` does not contain the local build-factory
foundation files that later alert-timeout hardening depends on.

This plan splits the local stack into a dependency-ordered upstream PR series
that can be rebuilt from `upstream/main` with clean history and small reviewable
diffs. Every PR in the series must be created from a remote-safe upstream base,
stage only its explicit file set, and avoid protected config/state paths.

## Current Upstream Gap

Direct tree inspection against `upstream/main` shows these local build-factory
files are absent upstream:

- `bin/openclaw_background_job_notify.py`
- `bin/openclaw_alerting_operator_run.py`
- `bin/openclaw_safe_queue_worker_manual.py`
- `bin/openclaw_safe_auto_accept.py`
- `bin/openclaw_pr_factory.py`
- `bin/openclaw_pr_watcher.py`
- `bin/openclaw_build_war_room.py`
- `docs/openclaw-build-war-room.md`
- `docs/openclaw-pr-factory.md`
- `tests/test_openclaw_background_job_notify.py`
- `tests/test_openclaw_pr_factory.py`
- `tests/test_openclaw_build_war_room.py`

The alert-timeout hardening patch also could not apply to `upstream/main`
because all three target files are absent there:

- `bin/openclaw_background_job_notify.py`
- `tests/test_openclaw_background_job_notify.py`
- `docs/openclaw-build-war-room.md`

That means alert-timeout hardening is not an upstream PR 1. It belongs after
the notifier and war-room documentation foundations exist upstream.

## Contribution Rules

For every upstream PR in this series:

- Start from `upstream/main` or the prior accepted upstream PR branch.
- Do not reuse local private-history branches.
- Do not bypass push protection.
- Do not force-push unless a human explicitly approves a corrected branch.
- Do not include protected config/state files:
  `openclaw.json`, `cron/jobs.json`, `exec-approvals.json`, `config/*`,
  `workspace/*`, `rollback/*`, or `flags/*`.
- Stage explicit files only; never use `git add .`.
- Keep commands read-only until the branch is verified.
- Run focused tests and `git diff --check`.
- Run a counts-only sensitive scan on touched files.
- Generate PR gate commands only after the branch is clean and verified.

## Dependency Graph

```text
PR 1 docs-only contribution plan
  -> PR 2 protected drift and redaction primitives
  -> PR 3 safe local command/window classifier
  -> PR 4 agent work queue foundation
  -> PR 5 background notification primitives
  -> PR 6 alerting operator wrapper
  -> PR 7 safe queue worker
  -> PR 8 build accelerator packet generator
  -> PR 9 PR factory scaffold
  -> PR 10 isolated worktree execution and local commit gate
  -> PR 11 PR gate generation and verifier
  -> PR 12 PR watcher
  -> PR 13 build war-room orchestrator
  -> PR 14 durable pending alert store and flush/archive resilience
  -> PR 15 alert live-delivery timeout hardening
```

Some PRs can be combined only after a local dry-run proves the combined diff is
small, self-contained, and still readable. The default should be to split.

## PR Series

### PR 1: Upstream Build-Factory Contribution Plan

- Title: `Document build-factory upstream contribution series`
- Scope: Add the upstream contribution plan as documentation only.
- Expected files:
  - `docs/openclaw-upstream-contribution-plan.md`
- Dependency: none.
- Tests:
  - `git diff --check`
  - counts-only sensitive scan on the doc
- Risk: low.
- Acceptance criteria:
  - Applies cleanly to `upstream/main`.
  - Contains no local runtime state, config, or private path content.
  - Gives reviewers the intended sequence before code arrives.
- Can apply cleanly to `upstream/main`: yes.

### PR 2: Protected Drift and Redaction Primitives

- Title: `Add protected drift and redaction primitives`
- Scope: Introduce the smallest read-only structural helpers needed by later
  queue and PR-factory gates.
- Expected files:
  - `bin/openclaw_protected_drift_preflight.py`
  - `tests/test_openclaw_protected_drift_preflight.py`
  - focused docs if needed
- Dependency: PR 1.
- Tests:
  - `py_compile`
  - focused protected-drift tests
  - `git diff --check`
- Risk: medium, because it defines safety vocabulary.
- Acceptance criteria:
  - Reads only structural protected drift.
  - Emits redacted output.
  - Does not restore, stage, commit, or mutate by default.
- Can apply cleanly to `upstream/main`: likely, after extraction from local
  imports and any runtime-only assumptions.

### PR 3: Safe Local Command/Window Classifier

- Title: `Add safe local command window classifier`
- Scope: Add the bounded safe-local-dev classifier used by queue and worker
  paths.
- Expected files:
  - `bin/openclaw_safe_auto_accept.py`
  - `tests/test_openclaw_safe_auto_accept.py`
  - `docs/openclaw-safe-auto-accept.md` if included upstream
- Dependency: PR 2.
- Tests:
  - `py_compile`
  - focused safe-auto-accept tests
  - `git diff --check`
- Risk: medium.
- Acceptance criteria:
  - Denies protected paths, broad staging, network/provider actions, updates,
    restarts, and shell-mutation shapes.
  - Stores only local bounded state when explicitly requested.
- Can apply cleanly to `upstream/main`: likely, if kept independent of local
  queue state.

### PR 4: Agent Work Queue Foundation

- Title: `Add local agent work queue foundation`
- Scope: Introduce queue schema, lane validation, explicit allowed-file
  handling, blocker reporting, and non-executing queue status.
- Expected files:
  - `bin/openclaw_agent_work_queue.py`
  - `tests/test_openclaw_agent_work_queue.py`
  - `docs/openclaw-agent-work-queue.md`
- Dependency: PR 3.
- Tests:
  - `py_compile`
  - focused queue tests
  - `git diff --check`
- Risk: medium-high because it becomes a shared primitive.
- Acceptance criteria:
  - No provider calls.
  - No live execution.
  - Protected files are rejected structurally.
  - Queue state paths are constrained to safe local state locations.
- Can apply cleanly to `upstream/main`: only after removing or staging any
  references to later notifier/worker behavior.

### PR 5: Background Notification Primitives

- Title: `Add background job notification primitives`
- Scope: Add redacted terminal alert contracts, dedupe state, dry-run behavior,
  and non-secret target resolution.
- Expected files:
  - `bin/openclaw_background_job_notify.py`
  - `tests/test_openclaw_background_job_notify.py`
  - `docs/openclaw-background-work-contract.md` if included upstream
- Dependency: PR 4 if queue integration remains, or PR 2 if extracted as a
  standalone primitive first.
- Tests:
  - `py_compile`
  - focused notifier tests
  - `git diff --check`
- Risk: medium.
- Acceptance criteria:
  - Dry-run by default.
  - Redacts target values and secret-like text.
  - Does not send live messages unless an explicit future gate is present.
- Can apply cleanly to `upstream/main`: yes only as a trimmed standalone
  notifier, or after PR 4 if queue imports remain.

### PR 6: Alerting Operator Wrapper

- Title: `Add alerting operator wrapper`
- Scope: Add the wrapper that runs child commands without shell evaluation,
  detects interactive waits, and emits terminal contracts through the notifier.
- Expected files:
  - `bin/openclaw_alerting_operator_run.py`
  - `tests/test_openclaw_alerting_operator_run.py`
  - `docs/openclaw-alerting-operator-run.md`
- Dependency: PR 5 and PR 4 if queue blocker types are reused.
- Tests:
  - `py_compile`
  - focused alerting-wrapper tests
  - `git diff --check`
- Risk: medium-high.
- Acceptance criteria:
  - No shell evaluation for structured commands.
  - No live alert delivery by default.
  - Timeout and interactive-wait behavior are covered by tests.
- Can apply cleanly to `upstream/main`: after notifier primitives exist.

### PR 7: Safe Queue Worker

- Title: `Add manual safe queue worker`
- Scope: Add the manual, bounded queue worker that processes safe
  status/report lanes and stops on protected drift.
- Expected files:
  - `bin/openclaw_safe_queue_worker_manual.py`
  - `tests/test_openclaw_safe_queue_worker_manual.py`
  - `docs/openclaw-safe-queue-worker-scheduler.md` only as disabled planning
- Dependency: PR 4, PR 5, PR 6, and PR 2.
- Tests:
  - `py_compile`
  - focused safe-worker tests
  - `git diff --check`
- Risk: medium-high.
- Acceptance criteria:
  - Manual only.
  - No scheduler activation.
  - No real Codex/provider execution.
  - Protected drift blocks unsafe lanes.
- Can apply cleanly to `upstream/main`: after queue and notifier primitives.

### PR 8: Build Accelerator Packet Generator

- Title: `Add build accelerator packet generator`
- Scope: Add local candidate classification and PR-ready packet generation.
- Expected files:
  - `bin/openclaw_build_accelerator.py`
  - `tests/test_openclaw_build_accelerator.py`
  - `docs/openclaw-build-accelerator.md`
- Dependency: PR 4, PR 5, and PR 2.
- Tests:
  - `py_compile`
  - focused accelerator tests
  - `git diff --check`
- Risk: medium.
- Acceptance criteria:
  - Produces local artifacts only.
  - Blocks protected paths and external/provider actions.
  - Does not dispatch, commit, push, or create PRs.
- Can apply cleanly to `upstream/main`: after queue/notifier primitives.

### PR 9: PR Factory Scaffold

- Title: `Add bounded PR factory scaffold`
- Scope: Add packet validation and local branch/worktree planning without live
  GitHub operations.
- Expected files:
  - `bin/openclaw_pr_factory.py`
  - `tests/test_openclaw_pr_factory.py`
  - `docs/openclaw-pr-factory.md`
- Dependency: PR 4, PR 5, PR 6, and PR 2.
- Tests:
  - `py_compile`
  - focused PR-factory tests
  - `git diff --check`
- Risk: medium-high.
- Acceptance criteria:
  - Scaffold-only commands work.
  - No push, PR creation, merge, scheduler activation, or protected writes.
  - Packet validation rejects protected paths and external actions.
- Can apply cleanly to `upstream/main`: after dependency helpers exist.

### PR 10: Isolated Worktree Execution and Commit Gate

- Title: `Add isolated PR lane execution gate`
- Scope: Add generated worktree execution, wrapper integration, verifier checks,
  and explicit local commit gate.
- Expected files:
  - incremental changes to `bin/openclaw_pr_factory.py`
  - incremental tests in `tests/test_openclaw_pr_factory.py`
  - PR factory docs update
- Dependency: PR 9 and PR 6.
- Tests:
  - focused PR-factory tests
  - wrapper tests
  - `git diff --check`
- Risk: high.
- Acceptance criteria:
  - Uses generated worktrees only.
  - Stages only explicit write sets.
  - Local commits require test evidence.
  - Still no push or GitHub API call.
- Can apply cleanly to `upstream/main`: after PR 9.

### PR 11: PR Gate Generation and Verifier

- Title: `Add PR creation gate verifier`
- Scope: Add plan-only push/PR command generation and local verification.
- Expected files:
  - incremental changes to `bin/openclaw_pr_factory.py`
  - incremental tests in `tests/test_openclaw_pr_factory.py`
  - PR factory docs update
- Dependency: PR 10.
- Tests:
  - focused PR-factory tests
  - `git diff --check`
- Risk: medium-high.
- Acceptance criteria:
  - Emits command strings only.
  - Requires explicit `--repo openclaw/openclaw`.
  - Requires fork-qualified `--head <fork-owner>:<branch>`.
  - Verifier rejects merge/automerge and command injection.
- Can apply cleanly to `upstream/main`: after PR 10.

### PR 12: PR Watcher

- Title: `Add read-only PR watcher`
- Scope: Add read-only PR status and summary commands.
- Expected files:
  - `bin/openclaw_pr_watcher.py`
  - `tests/test_openclaw_pr_watcher.py`
  - PR factory docs update
- Dependency: PR 11 for workflow context, though the watcher can remain
  technically standalone.
- Tests:
  - `py_compile`
  - focused PR-watcher tests with mocked `gh`
  - `git diff --check`
- Risk: low-medium.
- Acceptance criteria:
  - Runs only read-only `gh pr view`.
  - Classifies readiness.
  - Redacts comments/reviews and blocks protected-file readiness.
- Can apply cleanly to `upstream/main`: yes as standalone, but better after PR
  gate docs exist.

### PR 13: Build War-Room Orchestrator

- Title: `Add build war-room orchestrator`
- Scope: Compose queue, accelerator, PR factory, PR gate verifier, and safe
  worker into one bounded local command.
- Expected files:
  - `bin/openclaw_build_war_room.py`
  - `tests/test_openclaw_build_war_room.py`
  - `docs/openclaw-build-war-room.md`
- Dependency: PR 7, PR 8, PR 10, and PR 11.
- Tests:
  - `py_compile`
  - focused war-room tests
  - focused PR-factory tests
  - `git diff --check`
- Risk: high.
- Acceptance criteria:
  - No push, PR creation, merge, scheduler activation, update, or restart.
  - Stops at verified gate artifacts.
  - Reports blockers and next actions without raw private values.
- Can apply cleanly to `upstream/main`: only after queue, accelerator, notifier,
  and PR-factory dependencies.

### PR 14: Durable Pending Alerts and Flush Resilience

- Title: `Add durable pending alert fallback`
- Scope: Add pending alert store, flush retry behavior, archive handling, and
  isolated-worktree pending-alert centralization.
- Expected files:
  - incremental changes to `bin/openclaw_background_job_notify.py`
  - incremental changes to `bin/openclaw_alerting_operator_run.py`
  - incremental changes to `bin/openclaw_pr_factory.py`
  - tests for pending alerts, flush resilience, and archive behavior
- Dependency: PR 5, PR 6, PR 10, and PR 13 if war-room summaries report pending
  alert counts.
- Tests:
  - focused notifier tests
  - focused wrapper tests
  - focused PR-factory tests
  - focused war-room tests
  - `git diff --check`
- Risk: medium-high.
- Acceptance criteria:
  - Failed live delivery writes redacted local pending alerts.
  - Flush retries are bounded.
  - Archive behavior is local and redacted.
  - No scheduler or provider activation is introduced.
- Can apply cleanly to `upstream/main`: after notifier/wrapper foundations.

### PR 15: Alert Live-Delivery Timeout Hardening

- Title: `Live alert delivery timeout hardening`
- Scope: Apply the intended three-file timeout hardening patch once the
  notifier and war-room files exist upstream.
- Expected files:
  - `bin/openclaw_background_job_notify.py`
  - `tests/test_openclaw_background_job_notify.py`
  - `docs/openclaw-build-war-room.md`
- Dependency: PR 13 and PR 14.
- Tests:
  - `py_compile`
  - `pytest tests/test_openclaw_background_job_notify.py tests/test_openclaw_build_war_room.py`
  - `git diff --check`
- Risk: low-medium after dependencies land.
- Acceptance criteria:
  - Timeout behavior is covered by focused tests.
  - Changed files are exactly the intended three.
  - No protected paths or private runtime state are present.
- Can apply cleanly to `upstream/main`: no today; yes after dependencies.

## First PR To Attempt Tonight

The first upstream-compatible PR should be docs-only:

- Branch from `upstream/main`.
- Add only `docs/openclaw-upstream-contribution-plan.md`.
- Commit message: `Document build-factory upstream contribution series`.
- Do not include any local build-factory source files yet.

This PR is useful because it gives upstream reviewers a small, safe review
surface and establishes why later PRs are split instead of bundled.

## Do Not Push Yet

Do not push any branch that is based on local-only build-factory history. The
remote-safe route is:

1. Fetch `upstream/main`.
2. Create a new branch from `upstream/main`.
3. Apply only the files for the next PR in the series.
4. Run focused checks.
5. Generate and verify a PR gate.
6. Push only after the gate passes.

## Exact Prompt To Build PR 1

```text
Build upstream PR 1 from remote-safe upstream/main.

Goal:
Create a docs-only upstream contribution-plan PR branch from upstream/main.

Branch:
prf/upstream-build-factory-contribution-plan/docs

Files:
- docs/openclaw-upstream-contribution-plan.md

Hard rules:
- No protected config/state files.
- No git add .
- No push until gate verifies.
- No gh pr create.
- No scheduler/restart/update.
- Do not print secrets, tokens, chat IDs, approval IDs, or raw config.

Steps:
1. git fetch upstream main
2. Create a new worktree branch from upstream/main.
3. Add only docs/openclaw-upstream-contribution-plan.md.
4. Run:
   - git diff --check
   - counts-only sensitive scan on the doc
   - protected staged-file check
5. Commit:
   Document build-factory upstream contribution series
6. Generate and verify PR gate with:
   --base main
   --github-repo openclaw/openclaw
   --head chadsm-sys:prf/upstream-build-factory-contribution-plan/docs
7. Report exact push and PR create commands.
8. Do not push or create PR.
```
