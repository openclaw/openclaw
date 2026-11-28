# Release CI: recovery

## Receipt-backed aggregate recovery

**Check this path before replacing a drained FRV for a sealing/collector failure.** A failed parent, missing execution-plan cache/artifact, or unavailable same-parent continuation does not by itself require rerunning tests. After a reviewed tooling-only repair, `pnpm frv recover` can authenticate the original submission/admission and retained producer/child receipts under current trusted P, without changing C/Q or rebuilding publication artifacts.

`continue --failed` retries eligible failed work and reseals the same parent using its original plan. **`recover` creates a separate receipt-backed aggregate**; it does not turn the original failed parent green. Use the [canonical recovery contract](../../../../docs/reference/full-release-validation/evidence.md#receipt-backed-aggregate-recovery), including for originally admitted beta, stable, full, and extended-stable selections.

1. Confirm the original parent and selected work are terminal; classify failures and preserve the original admission, attempts, receipts, artifact identities, and Q grants. Recovery cannot replace unwaived required coverage, grant its own waivers, change Q, or repair invalid package bytes.
2. Select the exact current trusted-main P containing the reviewed recovery repair. Let the helper discover and authenticate the original evidence; never hand-reconstruct a plan or recovery request.
3. Dispatch once with a new private request file:

   ```bash
   pnpm frv recover --run <original-parent-run-id> \
     --workflow-sha <exact-trusted-main-P> --request-file <private-request-path> --json
   ```

4. Retain that file. For an attempted, interrupted, or unconfirmed request, reconcile **only that request**, never submit another:

   ```bash
   pnpm frv recover --reconcile-request <private-request-path> --json
   ```

5. Require authenticated, complete recovery and the normal final verification/publication preflight. A dispatched/running recovery is not qualification or publication. Missing evidence, changed attempts, or lost authority fail closed; diagnose that refusal before choosing fresh qualification. Record original and recovery run IDs separately and retain raw waived failures.

## Repair release tooling without changing the product (C ≠ Q)

Use [tooling recovery](../../../../docs/reference/full-release-validation/dispatch.md#recover-qualification-tooling-without-changing-the-candidate) for workflow, runner, harness, planner, receipt, or qualification-contract defects (November 2026 plan-cache incident), not shipped-byte defects.

| Defect owner                      | Change                                                                      | Preserve                                                                               |
| --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Product                           | C; qualify new source/package/version                                       | No Q workaround for a real product failure                                             |
| Qualification                     | Review/land executable repair on main; pin exact Q and its complete closure | Frozen C                                                                               |
| Waiver grants only                | Commit authorized ledger data directly to Q; new Q request/admission        | C, P, and eligible raw receipts, reevaluated under new Q grants                        |
| Admission/verifier/publisher only | P                                                                           | C/Q and valid evidence; explicitly select new Q if admission/workflow support needs it |

1. Record diagnosis, old C/Q/P, request, run/attempt, and artifacts.
2. Review new Q/P. Preserve C, context, profile, coverage, soak, platforms, publication scope, and frozen baseline selections.
3. Compare helper-resolved baselines with recorded selections; stop for review on differences. The helper owns the envelope—never edit reserved inputs.
4. Within existing dispatch authority, use a **new private request file**; populate preserved inputs (including other lane/provider inputs), then preview with `--dry-run`:

```bash
pnpm ci:full-release -- \
  --sha "$CANDIDATE_SHA" --target-ref "$RELEASE_CONTEXT" \
  --trusted-workflow-ref candidate --workflow-sha "$QUALIFICATION_SHA" \
  --admission-workflow-sha "$PUBLISHER_SHA" --admission-workflow-ref main \
  --pin-admission-workflow --request-file "$NEW_REQUEST_FILE" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION" \
  -f release_profile="$RELEASE_PROFILE" -f rerun_group=all \
  -f run_release_soak="$EFFECTIVE_SOAK" -f fail_fast=false
```

5. Let the helper create Q transport and obtain immutable P admission. Never hand-construct either or select moving main.
6. Reuse the exact successful parent through `pnpm release:candidate -- --full-release-validation-run-id <run> --skip-dispatch`, retaining original tag, P, route, scope, and other options. Checklist `--workflow-sha` means **P**; its fresh dispatch defaults Q=C. Avoid a second Q=C qualification.
7. Reconciliation preserves original Q. Changing Q needs a new request, never an edited record.
8. Reuse is neither automatic nor automatically invalid: preserve producer Q/run/attempt and authenticated receipt; require authenticated producer tooling, exact C/inputs/candidate bindings, current artifacts, and acceptance under current Q grants. Tooling changes alone do not invalidate execution; deliberately opt out of reuse when the new harness must run. Rerun invalid or unwaived failed work and reverify retained package/image payloads; never relabel a failed parent green.
9. Require successful final verification before publication. Supplemental Telegram: retained admitted Q ref/harness, package C. Parallels: isolated Q checkout/dependencies, exact C tarballs. Never use moving main or P's harness.
10. Record replacement tuple/evidence in handoff. This procedure grants no merge, dispatch, or publication authority.

## Run identity and retry budget

Before watching/recovery, record C, Q/ref, P/ref, target context ref, parent run ID, attempt, and phase. Ledger Code SHA and Release SHA as lifecycle roles (possibly the same commit). Record the immutable Release Publish parent receipt separately from the tag's source.

Immediately before **each core/plugin npm publish or dist-tag mutation**:

- Re-read the exact protected lightweight tag and revalidate the exact parent tuple.
- Reject missing, moved, annotated, wrong-SHA tags; same-name branches; or mismatched repository, workflow, run ID, attempt, tooling identity, or parent state.
- Never refresh either identity from current main. Other privileged writers remain blocked until their dependent enforcement changes land.

Conceptual phases:

- `beta-publish`: `release_profile=beta`, `run_release_soak=false`.
- `postpublish-confidence`: published-package inputs plus `run_release_soak=true` or explicit focused groups.
- `stable-publish`: `release_profile=stable` or `full`, with soak and blocking performance.

An `all` run without soak for an actual beta package on its matching canonical release branch or beta tag records `coveragePolicy=npm-beta-v1`:

- Keeps Linux/macOS/Windows Node, Control UI, plugin, package, install/update, Linux/Windows/macOS cross-OS, QA parity, runtime-pair/restart, and tool coverage; all selected tests gate npm/ClawHub.
- Defers native app CI, performance, and published-package Telegram to confidence. Beta `all` without soak also defers Package Acceptance Telegram, including beta-profile main checks.
- Record deferred checks as **not run**, never passed. Stable/full, soak, and focused groups retain coverage; selected children require terminal evidence. An absent coverage policy retains historical full behavior.

### Parent ownership and cancellation

- At most one active parent per C + Q + rerun group + release profile + effective soak coverage. Stable/full always include soak. Distinct coverage profiles may run independently; concurrency never automatically cancels an older exact child.
- Parent cancellation/timeout does not settle independent descendants. Preview `pnpm frv cancel --run <parent> --dry-run`; omit `--dry-run` for explicitly requested cancellation or the proactive supersession rule below within authorized release work.
- When deterministic failures require a repaired candidate or qualification run, proactively cancel the superseded FRV if every remaining job passed in the previous run and the intervening changes are unlikely to affect it. Record the prior run/attempt, changed-path assessment, failures, and cancellation reason; settle the owned tree, finish known repairs, then start fresh FRV. Prior passes justify stopping redundant diagnostics, not claiming the new candidate passed. Otherwise let useful diagnostics drain.
- The cancellation owner authenticates the sealed plan, exact dispatch logs, current attempts, artifact producers, and recorded Telegram descendants. Borrowed/reused children stay untouched.
- Repeat an incomplete cancellation's next command; use `--force` only when earlier cancellation is not settling. Never infer ownership from branches, title prefixes, or latest-run order. Settle the owned tree before dispatching a replacement.

### Diagnose before retrying

- Recover one failed surface with one diagnosis, one fix if needed, and one narrow retry; then reassess. Never automatically dispatch `rerun_group=all`.
- Before rerunning a failed/timed-out test, the lead records blocker versus flake (maintainer skill's shared release boundaries). Read its diagnostics, inspect same-SHA attempts, and compare failing paths with candidate changes and recent main history. A main fix is absent from the frozen candidate until ancestry or patch equivalence proves otherwise.
- If a job passed in the previous run and intervening code or qualification changes are unlikely to affect it, treat the new failure as a flake unless evidence points to a race that could harm production users. Record the previous run/attempt and why its inputs remain relevant; an exact-same-SHA pass is useful evidence, not a prerequisite.
- Apparent infrastructure failures and test flakes are eligible for the full bounded retry budget unless evidence proves a deterministic defect or a production-impacting race. Repetition alone does not prove determinism. Reassess each failure using its signature and mechanism; a production race is a real defect even if a retry passes.
- Flakes get at most **two recorded reruns on the same Release SHA**, plus a fix-in-parallel issue/PR on main; never a re-cut, tooling change, or new FRV. New dispatches reject `known_flaky_jobs_json`.

### Controller recovery

**One job:** `pnpm frv rerun --run <parent-run-id> --job "<child-key>:<exact job name>"`

- Supported parents: rerun one executed terminal job by accepted Actions job ID. Get key/name from `frv status --json`; GitHub also reruns dependent jobs.
- Waits only for that child before requesting; never retries unrelated failures.
- Normally follows the whole tree through parent reseal. `--no-follow` returns when the new attempt appears; then use `continue --failed` to reseal.

**One child:** `pnpm frv rerun --run <parent-run-id> --child <child-key|run-id> [--max-attempts N]`

- Waits for completion; requires exactly one blocking failed job. Requests its accepted Actions job ID once; returns when the new attempt exists without duplicates.
- Before requesting, prints failed-job runner labels/current `OPENCLAW_CI_RUNNER_BACKEND`. Afterward, appends an audit line to `$TMPDIR/openclaw-frv/<repo>-<parent>-reruns.jsonl`.
- Refuses passed children, artifact producers (use `continue --failed`), multiple blockers, and exhausted budgets. Default **2** permits one rerun; use `--max-attempts 3` for failures classified as flakes under the policy above, including apparent infrastructure/test flakes, to allow the second bounded rerun. Controller identity and recovery-shape restrictions still apply; classification does not override them.
- Multiple blocking jobs require fresh all-group FRV. Reseal with `continue --failed`.

**Failed children/producers:** `pnpm frv continue --failed --run <parent-run-id>`

- Same exact-job restriction per terminal failed child/artifact producer, even with active parent/siblings. Refuses multi-job recovery and directs fresh all-group FRV.
- Adopts active attempts and preserves green children. Once required children are green and original parent finishes, reruns parent once to restore immutable plan/seal updated all-group manifest.
- Early retry can invalidate original Decision/Drain pairing; final reseal and strict verification own completion.

- GitHub ghost jobs—runnerless queued copies of a job name—can follow single-job or batched requests and make attempts unsealable. Send at most one request per child, after it is terminal; never stack separate job reruns. Duplicates may settle within the controller's **60-second** reconciliation window. Once reported as persistent ghost jobs, stop rerunning that FRV: cancel the attempt and start fresh all-group FRV.
- `continue --failed` reruns each failed child once per invocation. If that child fails again, it exits immediately with attempt/remaining budget, without waiting for siblings. Invoke again for a failure still classified as an infrastructure/test flake within budget; proof of a deterministic defect or production-impacting race stops flake retries.
- Each child/parent mutation is sent once per invocation. Ambiguous transport failure triggers bounded read-only reconciliation. After interruption/timeout, inspect exact attempts before repeating. Targeted JSON records job ID, accepted source attempt, and observed retry attempt. Keep the command in a long-running shell for its default **12-hour** operation budget.
- Inspect without mutation:

  ```bash
  pnpm frv status --run <parent-run-id>
  pnpm frv verify --run <successful-parent-run-id>
  ```

- Plans predating attempt-aware evidence cannot use same-parent continuation: settle the owned tree and preserve old receipts. Assess [receipt-backed aggregate recovery](#receipt-backed-aggregate-recovery) against its original-admission/receipt requirements before choosing fresh all-group FRV; never reconstruct old state. Attempt-aware plans retain the parent and targeted recovery rules above.
- Controller retry handles: `ci`, `plugin-prerelease`, `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`, `performance`. Removed: `release-checks`. `qa` is a direct-child manual aggregate, not a controller retry API.
- Filters fail closed unless they belong to the selected group. All-group also accepts `cross_os_suite_filter`; e.g. `-f cross_os_suite_filter=ubuntu,macos` excludes Windows. `npm-stable-v1`/`npm-beta-v1` still qualify with explicitly filtered OS omissions if all Linux suites remain selected and other policy requirements hold. Never turn an empty derived filter into an unfiltered broad run.
- New all-group parents require changed shared orchestration, evidence invalid for the selected tuple, or explicit operator request. Record the invalidating event.
- Narrow child/group evidence is not publish authorization; ledger it for the release owner's current-gate judgment.
