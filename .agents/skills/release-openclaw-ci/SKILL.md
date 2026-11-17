---
name: release-openclaw-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use with `$release-openclaw-maintainer` and `$openclaw-testing` for candidate validation, install/update proof, live-provider checks, and CI recovery.

## Guardrails

### Scope and authority

- **Ask first:** version bumps, tags, npm/GitHub releases, and release promotion need explicit operator approval.
- After compaction, resume, or steering, restate the effective goal/phase from the latest explicit instruction. Do not restore superseded scope.
- Once a release branch or Code SHA exists, validate and ship that release—not moving `main`.
- **Frozen-Code firebreak:** admit only confirmed product/security defects, wrong or unverifiable package bytes, or publication blockers. Queue other findings for postpublish confidence/next beta.
- Dependency advisories are evidence, not firebreak admissions: queue bumps on `main` after publication. Only known malware stops publication.
- Touch `main` only for operator-requested changes or the smallest critical main-owned release blocker that cannot be handled on the release branch. Main CI health does not gate release.
- For tooling landings blocked by unrelated main failures: reproduce on clean `main`, record in the PR, and merge. Admin merge is allowed for that exact case during a release; fix red main in a separate parallel lane.
- Tooling-only PRs: add `release-fast-lane` **before pushing**; follow [Release tooling fast lane](#release-tooling-fast-lane) and [native review/landing](../openclaw-pr-maintainer/references/landing.md). The label narrows `openclaw/ci-gate`, not review or landing rules.

### Frozen identities and qualification

- Record **C** (candidate), **Q** (qualification), **P** (admission/aggregate/verifier/publisher), rerun group, profile, effective soak, and context/transport refs. Code SHA and Release SHA are lifecycle roles, not extra workflow identities.
- Default **Q=C**. Freeze C/Q; select trusted P on main or a protected publication tag. C need not be P's ancestor. Independent Q must be reviewed and a verified main ancestor.
- Q owns the complete workflow/reusable-workflow, action, script, planner, contract, harness, and coverage closure. P owns aggregate decisions and checked-in waivers. Future-main checks/scenarios are not implicit requirements.
- Missing contracts need a deliberate Q repair or candidate backport; never substitute moving main. Q-only repair may preserve C, but needs new Q, request/admission, and a successful parent. Never edit an old request or relabel failed FRV. P-only repair can preserve C/Q and valid original evidence.
- Candidate tags: absent is allowed; existing lightweight/annotated tags must resolve to exact C. Conflicts or failed remote lookup stop validation; never move a tag to recover.
- Protected lightweight `release-publish/<12sha>-<provenance-run>` tags identify P, not Q. Suffix = tag-creation provenance, not current parent. Publication/checklist `--workflow-sha` selects **P**; FRV `--workflow-sha` selects **Q**.
- FRV must succeed under pinned P's [waiver policy](../../../docs/reference/full-release-validation/evidence.md#release-tooling-waivers); every other required lane must pass. [Stable publication](#publication-requirements) needs stable/full evidence, mandatory soak, and blocking performance. Beta proof cannot qualify stable; only checked-in performance exceptions apply.
- All-group qualification covers all nine Linux/Windows/macOS Gateway install/upgrade combinations. Preserve first failures, identities, and complete evidence.
- Regular releases may use one Code SHA = Release SHA and one successful fresh full parent for both roles and exact publication bytes. Later notes-only reuse requires the complete delta from Code SHA to change the selected `CHANGELOG/YYYY.M.PATCH.md`, optionally `CHANGELOG.md` and its matching `CHANGELOG/records/YYYY.M.PATCH.md`; no other paths, renames, or deletions. Changed bytes still need qualification.
- Extended-stable validates one exact branch tip, not regular Code-SHA/Release-SHA reuse.

### Runtime, capacity, and independent publication

- Frozen CI uses Q's Node planner/measured costs to discover and execute C's tests. Hosted full-release plans split measured rows above **12 minutes**; retain file coverage, worker limits, and complete timing generations. Split indivisible over-budget owners; do not raise the budget.
- After the child finishes, run `scripts/ci-shard-timings-refresh.mts` for that exact run and commit generated costs. Never hand-edit measurements.
- Optional `OPENCLAW_RELEASE_RUNNER_GROUP`: configure runners/repo access first. It routes validation parents/workers and Release Publish parent/children with unchanged labels; shared workers inherit it. Credentialed publish/approval jobs retain default GitHub-hosted labels. Unset keeps ordinary routing; PR/main CI and unrelated schedules stay outside it.
- Before fresh main validation, check the Code SHA's nightly parent for reusable exact-target child receipts. Nightly uses `--sha <main-sha> --workflow-sha <main-sha> --trusted-workflow-ref main`; its parent ref is `release-ci/<sha12>-<id>`, not `main`.
- Selected npm plugins must publish before core npm. ClawHub starts at its existing dispatch point, then owns independent planning, authorization, dispatch, publication, verification, and recovery. It never blocks core, GitHub finalization, main closeout, or retrospective PR. Record its owner, exact run/attempt, status, and next action.
- Native macOS/Windows/Linux/Android publication is independent of npm/ClawHub, GitHub finalization, and main closeout. Preserve platform signing, qualification, artifact, and updater gates; report pending platforms and repair native-only failures in parallel.

### Credentials and observation

- Use `$one-password`: one persistent tmux session, targeted reads/writes, no secret output. Never set GitHub secrets from unvalidated candidates; on 401/403 preserve the existing secret and name the missing provider.
- Separate live-provider flakes from code defects: prove key validity, HTTP status, retry evidence, and exact lane before editing. Model-list success proves authentication, not billing/inference entitlement; probe a real completion from the same credential first. Fix credentials, not an alternate auth bypass.
- One release operator, one [`pnpm frv watch --run <parent>`](#watch), at most one investigator for the current failure. No audit/review/plan trees for one transition.
- Fetch only failed/currently blocking job logs. Avoid broad `gh run view` polling; when quota is low, wait for reset.

### Plans, attempts, and recovery

- FRV separates child dispatch, Release Decision, and Diagnostic Drain. `fail_fast=false` makes **zero** child-cancellation calls; Drain follows selected children to terminal unless cancelled itself or denied GitHub API access. `fail_fast=true` may cancel only the exact active child owning a blocker.
- Same-parent continuation requires the root's original logged `fail_fast=false`; the controller checks before mutation.
- A parent that sealed its own candidate artifacts cannot continue: reruns make prior-attempt artifacts unavailable. Keep C/Q frozen, supersede it, and start fresh all-group FRV.
- One immutable execution-plan artifact seals original parent attempt, exact child tuples/titles, coverage, gates, and reuse identity; identical bytes are cached by exact run ID. Decision, Drain, manifests, evidence validation, and final verification consume the current attempt's artifact.
- Collector retry: restore/validate cached plan, re-upload, adopt the same children. Missing plan is orchestration failure—not permission to reconstruct or redispatch.
- Before `passed`, Decision rechecks reused evidence: sealed target/evidence SHAs, policy, changed paths, selected/root runs, source manifest, trusted tooling identity, and exact children. Sealing alone is not trust.
- Parent retry selects newest Decision and Drain independently; both must bind the same immutable plan even if source attempts differ.
- Child retry stays in-plan only with exact run ID, workflow path/ref/Q, dispatch title/event, target, candidate, and validation inputs. Newer attempts replace matching jobs; absent jobs carry forward. Duplicate identities, missing/regressed attempts, or changed tuples fail closed.
- `frv status`/`continue` allow **60 seconds** of read-only reconciliation for transient newest-attempt duplicate jobs. Tuple/attempt stay pinned; persistent duplicates and older-attempt conflicts remain errors.
- Use `pnpm frv status|watch|rerun --job|rerun --child|continue --failed|verify`. Controller is stateless; plan, exact GitHub attempts, Drain, and final manifest are authorities. It never writes tags, packages, registry entries, release candidates, or publications.
- **Post-merge controller proof:** use reviewed landed SHA on protected main through non-release `FRV Proof Broker` + `FRV Proof Fixture`, never real FRV. Dispatch broker with merged PR and exact landed commit; require PR merge commit equality and landed commit equal/ancestor of trusted workflow SHA. Recheck authority, merge, and ancestry immediately before fixture rerun.
- Require the exact fixed no-op fixture to change intentional attempt-one failure → attempt-two pass; the broker emits its receipt. No release candidate/artifact/publication/ref/replacement parent or other workflow mutation. Hosted proof covers targeted-job rerun; focused tests cover immutable-plan eligibility, green-attempt preservation, same-parent collection, and strict-verifier invocation. See [continuation proof](/reference/full-release-validation#post-merge-continuation-proof).

### Isolated checkouts and Testbox

- Sparse worktree/Testbox sync: verify `package.json`, `pnpm-lock.yaml`, and **every** selected-check input. Missing inputs → use remote changed gate/full task worktree, not dependency/Docker validation from that checkout.
- If inputs exist and package/lock changes, rebuild only the task-owned disposable box with `CI=true pnpm install --frozen-lockfile`; then probe `require.resolve()` before Docker/focused tests. `CI=true` permits noninteractive recreation of prewarmed modules. Never weaken locks or call sparse failures product/Docker defects.
- Candidate rebased/base changed after warmup → stop the task box and warm a fresh one. Relative source sync can otherwise mix old-base files with new diffs and create false lock/Docker failures.
- Reused Testboxes check recorded source after first successful run. Source-only edits can reuse; base/dependency/wrapper/workflow drift needs a fresh lease. Never use `OPENCLAW_TESTBOX_ALLOW_STALE=1` for release proof.
- Supported committed-candidate capsule: from C's checkout, run `node scripts/crabbox-wrapper.mjs run --blacksmith-ref main -- <command>`. Capsule preserves C/dependencies; main supplies admission limits. If wrapper contract is absent, use exact-target release validation with separate Validation/Tooling SHAs. Never dispatch candidate Testbox refs or borrow another checkout's wrapper.

## Repair release tooling without changing the product (C ≠ Q)

Use [tooling recovery](../../../docs/reference/full-release-validation/dispatch.md#recover-qualification-tooling-without-changing-the-candidate) for workflow, runner, harness, planner, receipt, or qualification-contract defects (November 2026 plan-cache incident), not shipped-byte defects.

| Defect owner                      | Change                                                                         | Preserve                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Product                           | C; qualify new source/package/version                                          | No Q workaround for a real product failure                                             |
| Qualification                     | Review/land repair on main; pin exact main-ancestor Q and its complete closure | Frozen C                                                                               |
| Admission/verifier/publisher only | P                                                                              | C/Q and valid evidence; explicitly select new Q if admission/workflow support needs it |

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
8. Reuse is neither automatic nor automatically invalid: preserve producer Q/run/attempt and authenticated receipt; require identical workload closure, exact C/inputs/candidate bindings, current artifacts, and policy acceptance. Shared-script changes invalidate all roles; non-normal-CI roles compare full workflow/root trees. Rerun invalid/failed work and reverify retained package/image payloads; never relabel a failed parent green.
9. Require successful final verification before publication. Supplemental Telegram: retained admitted Q ref/harness, package C. Parallels: isolated Q checkout/dependencies, exact C tarballs. Never use moving main or P's harness.
10. Record replacement tuple/evidence in handoff. This procedure grants no merge, dispatch, or publication authority.

## Keep FRV off the idle path

Optimize time to the next **passing** FRV; overlap remote validation with repairs/proof. This is scheduling advice, not another gate, checklist, deadline, or demand for certainty. Existing release gates apply.

- **Start promptly:** favor overlapping useful local checks with remote FRV rather than completing all of them first. Uncertainty alone is no reason to idle; supersede through normal recovery if local work finds a defect.
- **Repair as failures arrive:** prioritize known non-flake repairs over optional confidence checks; diagnose them while other lanes drain. Use independent repair lanes when useful; integrate ready fixes without waiting for the final report.
- **Aim to finish repairs by drain completion:** focused proof/review included. If longer, keep repairing—no redundant checks or process filler.
- **Before next FRV:** fix every known non-flake affecting C/Q/P. Do not launch with known failure B after fixing A; no requirement to eliminate unknowns or unrelated issues.
- **Retry strategically:** eligible targeted retries can overlap diagnostics. Use the [budget](#run-identity-and-retry-budget) for flakes/repaired external prerequisites; retain valid green proof. Fix deterministic failures rather than repeat them. Start necessary fresh parents without optional delay.

### Optional broad CI discovery alongside initial FRV

Optional diagnosis, **not** a prerequisite, checklist, or release gate:

1. Inspect recent scheduled `CI` and `Plugin Prerelease` failures, SHAs, and coverage. Treat them as diagnostic leads, not verdicts on another candidate; keep unrelated main-only fixes off the critical path.
2. Prefer initial FRV's CI/plugin children when they cover C. For missing coverage or a separate repair revision, consider one full-tier CI/complete-plugin-inventory pass on that revision **alongside**, not before, initial FRV. Let FRV also find package/upgrade/live-provider/non-CI failures. Do not duplicate active children or broad-run after every fix.
3. Let independent diagnostics finish; group failures and prove fixes with affected tests/shards. Feed release-relevant fixes into the next candidate under existing intake/evidence rules. Discovery neither authorizes unrelated changes nor counts as release proof.

## Deferred CI recovery

- Release validation does not pause CI/supporting workflows.
- Current admission ignores legacy `OPENCLAW_RELEASE_PRIORITY_RUN`; `pnpm frv prioritize --run` is retired.
- Recover older deferred runs/clear their variable with `pnpm frv prioritize --restore <record>`. Preserve publication proofs and soak gates.

## Continuous release readiness

- Scheduled main validation: every **3 hours at :07 UTC**; seals a direct-root manifest and per-child receipts for exact main SHA.
- Same-day cut: land version/changelog train on main before the scheduled run; cut `release/YYYY.M.PATCH` at its SHA so Code SHA = validated SHA.
- Child adoption matches exact target, role, and dispatch inputs except `dispatch_id`. Context-free `productPerformance` inputs match and are adopted.
- Stable `--target-ref release/YYYY.M.PATCH` selects `coveragePolicy=npm-stable-v1`, `ci_release_scope=npm-stable`; main uses `full`. `normalCi`, plugin prerelease, and release checks redispatch: `target_context_ref` inputs differ, plugin/release checks add `allow_frozen_target_scenario_omissions=true`, and scope differs.
- Whole-parent adoption needs byte-identical manifest `validationInputs`, including `validationPurpose`, `publicationSelectionJson`, `targetContextRef`, `targetVersion`, `allowUnreleasedChangelog`, and `coveragePolicy`. A `main-qualification` nightly cannot qualify a `publish` stable candidate wholesale. Purpose/context-crossing adoption remains a verifier-policy follow-up.

## Release tooling fast lane

- Add `release-fast-lane` before the triggering push: CI reads event labels; label events do not start CI. Already pushed: `gh pr ready --undo` then `gh pr ready` retriggers with current labels.
- Eligible: canonical PR, all paths in `.github/workflows/**`, `scripts/**`, `test/scripts/**`, `.agents/skills/release-*/**`, `docs/reference/RELEASING.md`, or independently checked docs.
- Keeps `security-fast`, `check-shard` (lint, prod/test types, guards, dependencies, npm lock), changed-docs `check-docs`, and changed Node rows. Planner compact-packing full-plan proof narrows to those rows.
- Skips contracts, baseline ratchets, bundled protocol, Bun launcher, additional checks, build artifacts (unless changed rows need `dist`), Control UI, Windows/macOS/iOS/Android, i18n, and skills. Preflight summary lists skips under "Release fast lane".
- Declined for out-of-scope/global-Node inputs, forks, push/dispatch, or docs-only: warn and retain ordinary selection. Every selected lane must pass; hourly full main CI covers merged results.
- Label changes only CI selection. [Native maintainer workflow](../openclaw-pr-maintainer/references/landing.md) still owns review/landing; fork heads are declined.

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
- Parent cancellation/timeout does not settle independent descendants. Preview `pnpm frv cancel --run <parent> --dry-run`; omit `--dry-run` only for explicitly requested cancellation.
- The cancellation owner authenticates the sealed plan, exact dispatch logs, current attempts, artifact producers, and recorded Telegram descendants. Borrowed/reused children stay untouched.
- Repeat an incomplete cancellation's next command; use `--force` only when earlier cancellation is not settling. Never infer ownership from branches, title prefixes, or latest-run order. Settle the owned tree before dispatching a replacement.

### Diagnose before retrying

- Recover one failed surface with one diagnosis, one fix if needed, and one narrow retry; then reassess. Never automatically dispatch `rerun_group=all`.
- Before rerunning a failed/timed-out test, the lead records blocker versus flake (maintainer skill's shared release boundaries). Read its diagnostics, inspect same-SHA attempts, and compare failing paths with candidate changes and recent main history. A main fix is absent from the frozen candidate until ancestry or patch equivalence proves otherwise.
- A flake requires the same job or signature to have passed on the same Release SHA. Repetition on this or another candidate is deterministic until a named mechanism and fix prove otherwise.
- Flakes get at most **two recorded reruns on the same Release SHA**, plus a fix-in-parallel issue/PR on main; never a re-cut, tooling change, or new FRV. New dispatches reject `known_flaky_jobs_json`.

### Controller recovery

**One job:** `pnpm frv rerun --run <parent-run-id> --job "<child-key>:<exact job name>"`

- Supported parents: rerun one executed terminal job by accepted Actions job ID. Get key/name from `frv status --json`; GitHub also reruns dependent jobs.
- Waits only for that child before requesting; never retries unrelated failures.
- Normally follows the whole tree through parent reseal. `--no-follow` returns when the new attempt appears; then use `continue --failed` to reseal.

**One child:** `pnpm frv rerun --run <parent-run-id> --child <child-key|run-id> [--max-attempts N]`

- Waits for completion; requires exactly one blocking failed job. Requests its accepted Actions job ID once; returns when the new attempt exists without duplicates.
- Before requesting, prints failed-job runner labels/current `OPENCLAW_CI_RUNNER_BACKEND`. Afterward, appends an audit line to `$TMPDIR/openclaw-frv/<repo>-<parent>-reruns.jsonl`.
- Refuses passed children, artifact producers (use `continue --failed`), multiple blockers, and exhausted budgets. Default **2** permits one rerun; `--max-attempts 3` only for confirmed flakes.
- Multiple blocking jobs require fresh all-group FRV. Reseal with `continue --failed`.

**Failed children/producers:** `pnpm frv continue --failed --run <parent-run-id>`

- Same exact-job restriction per terminal failed child/artifact producer, even with active parent/siblings. Refuses multi-job recovery and directs fresh all-group FRV.
- Adopts active attempts and preserves green children. Once required children are green and original parent finishes, reruns parent once to restore immutable plan/seal updated all-group manifest.
- Early retry can invalidate original Decision/Drain pairing; final reseal and strict verification own completion.

- GitHub ghost jobs—runnerless queued copies of a job name—can follow single-job or batched requests and make attempts unsealable. Send at most one request per child, after it is terminal; never stack separate job reruns. Duplicates may settle within the controller's **60-second** reconciliation window. Once reported as persistent ghost jobs, stop rerunning that FRV: cancel the attempt and start fresh all-group FRV.
- `continue --failed` reruns each failed child once per invocation. If that child fails again, it exits immediately with attempt/remaining budget, without waiting for siblings. Invoke again only for a confirmed flake within budget.
- Each child/parent mutation is sent once per invocation. Ambiguous transport failure triggers bounded read-only reconciliation. After interruption/timeout, inspect exact attempts before repeating. Targeted JSON records job ID, accepted source attempt, and observed retry attempt. Keep the command in a long-running shell for its default **12-hour** operation budget.
- Inspect without mutation:

  ```bash
  pnpm frv status --run <parent-run-id>
  pnpm frv verify --run <successful-parent-run-id>
  ```

- Plans predating attempt-aware evidence cannot continue: settle the owned tree, preserve old receipts, and start fresh all-group FRV. Never reconstruct old state. Attempt-aware plans retain the parent and targeted recovery rules above.
- Controller retry handles: `ci`, `plugin-prerelease`, `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`, `performance`. Removed: `release-checks`. `qa` is a direct-child manual aggregate, not a controller retry API.
- Filters fail closed unless they belong to the selected group. All-group also accepts `cross_os_suite_filter`; e.g. `-f cross_os_suite_filter=ubuntu,macos` excludes Windows. `npm-stable-v1`/`npm-beta-v1` still qualify with explicitly filtered OS omissions if all Linux suites remain selected and other policy requirements hold. Never turn an empty derived filter into an unfiltered broad run.
- New all-group parents require changed shared orchestration, evidence invalid for the selected tuple, or explicit operator request. Record the invalidating event.
- Narrow child/group evidence is not publish authorization; ledger it for the release owner's current-gate judgment.

## Preflight

Run in approved isolation, outside trusted admission/dispatch tooling:

**Before dispatch**

- Run `pnpm check:test-mock-exports --base <frozen-sha>` in exact candidate checkout with frozen dependencies.
- Failure blocks dispatch; rerun after any candidate change. FRV repeats before child fanout. Keep candidate execution outside trusted admission.

**Before full matrix dispatch**

- Run `pnpm ui:i18n:check` and `pnpm native:i18n:check` on frozen trusted target; bind both to exact SHA.
- Generated-locale drift warns; continue dispatch without requiring regeneration. Source edits/serialized refresh workflows can leave generated output temporarily behind.
- Normal CI retains strict `control-ui-i18n`/`native-i18n` jobs and actual summary results; selected failures block npm/ClawHub. PR/release-prep gates stay unchanged.
- Never execute arbitrary target checkout as helper code.

**Before expensive full validation**

- Run `pnpm ui:build` on that same target/frozen dependencies.
- Record SHA plus successful production build, precompressed-asset verification, startup/largest-asset budget results. Any failure blocks fanout.
- No dev-server substitute or budget increases.

For local full E2E, include private QA entries in the frozen, dependency-ready proof checkout's initial build:

```bash
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build
```

Then use the selected E2E command's normal readiness checks. `scripts/lib/vitest-build-prerequisites.mts` requests private entries; `scripts/run-node.mts` otherwise triggers a full rebuild for `missing_private_qa_dist`. Scope the flag to this task-owned checkout/command. Release workflows/sealed artifacts still own publication package/image bytes.

Before full release validation:

```bash
gh api rate_limit --jq '.resources.core'
git status --short --branch
git rev-parse HEAD
```

### Before publication

- Regular beta/stable protected publication: after evidence validation, run `pnpm release:publish-preflight` with intended tag, exact FRV run/attempt, npm dist-tag, plugin scope, and protected tooling ref. `pnpm release:candidate` supplies its downloaded manifests; do not redownload or replace the attempt. Resolve every `FAIL` and owner-action `WARN` before using the report's exact route-specific dispatch command. Extended-stable has separate owner workflows, outside this preflight; alpha is retired.
- Checklist `--workflow-ref`/`--workflow-sha` selects P, not candidate harness. Reuse authenticated stable Telegram proof from the exact qualified tarball; beta remains deferred. Supplemental Telegram requires the retained qualification ref verified at admitted Q, harness pinned to Q, and package source pinned to C—never moving main. Parallels uses isolated Q checkout/dependencies against exact C tarballs. Supplemental Telegram run IDs belong in candidate evidence, not the optional publisher diagnostic input.
- Before retrying publication, inspect the report: preserve verified `openclaw_npm_resume_run_id` for published core bytes; inspect matching draft/published release; identify exact orphan plugin/ClawHub children before cancellation.
- Preflight is read-only: no publish/cancel authority and no proof of repository secrets from local credentials.
- Bootstrap candidates need the release credential owner to confirm `NPM_TOKEN` readiness; follow [bootstrap credential readiness](../release-openclaw-maintainer/references/publication-recovery.md#check-the-bootstrap-token). Do not publish or rotate credentials during preflight.

## Dispatch

After source admission, plugin compatibility readiness, and reuse selection:

- Dispatch source-only children alongside npm/Docker artifact producers.
- Acquire candidates from raw npm bytes while qualification continues. Start candidate Plugin Prerelease/Release Checks immediately after candidate verification, without waiting for independent validation or Docker.
- Preserve immutable execution plan and final artifact qualification.

### Child receipts and reuse

Each selected child uploads trusted immutable `full-release-child-evidence-<target-sha>-<role>-<run-id>-<attempt>`. It retains normalized dispatch inputs/candidate descriptors, composes predecessor jobs across attempts, and excludes the running publisher from `workloadConclusion`. Collection failure loses reuse metadata, not workload qualification.

With `reuse_evidence=true`:

- Within **two minutes**, scan at most **100** recent runs, probe at most **40** target receipt inventories, and fully validate at most **five** matching receipts per role. Nonmatching inventories do not spend full-validation budget.
- Empty-string inputs equal absent inputs (GitHub omits them from `github.event.inputs`); nonempty defaults and candidate descriptor bytes match exactly.
- Green children may come from failed, cancelled, or active parents at the same Q, or across Q only with authenticated Git-tree proof of identical workload closure. Independent Q requires verified main ancestry; missing/unsupported/changed closure fails closed.

| Closure     | Exact contents                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All roles   | Owning/reusable workflows, local actions, complete scripts tree, root config/dependency files. Shared-script changes invalidate every child, regardless of control-only intent.                                                                                       |
| Normal CI   | Also complete `config`, `packages`, `src`, `test` trees for Q-owned harness dependencies; even unrelated changes there invalidate reuse. Other product directories come from C and are excluded. Unrelated parent-workflow changes alone do not invalidate normal CI. |
| Other roles | Conservatively all workflows and full root tree.                                                                                                                                                                                                                      |

- Logs identify reuse, evaluated rejections, skipped runs, and fresh dispatches. Current-parent adoption witness/immutable plan bind each selection.
- Collectors/final verification recheck live attempt/conclusion, closure, main ancestry, inputs, artifact identity/digest/expiry, and successful trusted seal/upload. A newer attempt invalidates reuse; never rerun an adopted child to repair collection.
- Current-parent source/publication admission, successful-parent changelog reuse, and artifact producers' sealed receipts are unchanged.
- Cross-Q reuse retains original producer Q, exact C/role/effective inputs/defaults/candidate descriptor/receipt/artifact/live attempt. Green jobs or parent-only fixes do not establish eligibility; changed closure needs fresh children. Whole-parent authenticated reuse has a separate exact-Q/P contract. Never relabel failed FRV; tooling recovery requires a fresh successful parent.

### Optional beta performance

Optionally start standalone performance against frozen Code SHA in parallel:

```bash
# Optional beta confidence; stable/full qualification requires blocking performance.
fail_on_regression=false
gh workflow run openclaw-performance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_ref=<code-sha> \
  -f profile=release \
  -f repeat=3 \
  -f deep_profile=false \
  -f live_openai_candidate=false \
  -f fail_on_regression="$fail_on_regression"
```

- No separate mandatory prepublish wait for this beta signal. Compare available Kova, gateway-startup, and CLI-startup metrics with earlier release evidence/clawgrit before publish/closeout; record regressions and investigate product impact.
- Stable/full needs blocking performance, subject only to checked-in policy's exact Kova grants. Retain failed reports; failed-job grants do not exempt not-run jobs.
- `npm-beta-v1` defers performance. Every selected child still needs terminal evidence and proof of artifact-only publication.

### Admit and dispatch the exact tuple

Only the canonical helper performs lightweight `admit-qualification` on `openclaw-release-prepare.yml` at P, then dispatches FRV at Q. P records operator attestation, complete normalized inputs, and data-only frozen Q coverage; the immutable descriptor travels in the existing `trusted_workflow_json` envelope. Never execute candidate code in P admission or hand-assemble the envelope.

```bash
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --trusted-workflow-ref candidate \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  --request-file <private-request-file> \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

- Q defaults to C; candidate-route `--workflow-sha <Q>` selects an explicit reviewed main ancestor. C owns source, package bytes, version, baselines; Q owns complete qualification closure. P may use an existing protected `release-publish/*` tag at its exact SHA.
- Review candidate/coverage before dispatch: admission records operator attestation, not a bot exception. Scheduled main qualification explicitly uses `--trusted-workflow-ref main` and trusted-main semantics.
- Beta publication: `npmDistTag=beta`. Use `route=prepared` only for intended prepared-button consumers. Source admission neither qualifies registry state nor authorizes publishing.
- Purposes: nonpublish investigations `validation_purpose=diagnostic` with no publication selection; recurring main `main-qualification`; exact published-package confidence `postpublish-confidence`. Select coverage/profile independently.

### Request reconciliation

- Existing `--request-file` reconciles original route, Q/P, and inputs unchanged. `--reconcile-request <file>` is read-only; only `--resume-request <file>` continues after admission and before first FRV POST.
- If Q-ref creation succeeded but readback failed, resume verifies/reuses exact admitted Q ref and empty workflow inventory without another ref POST. Missing/moved refs or uncertain/nonempty inventories block.
- Read-only reconciliation verifies an uncertain prepared ref before suggesting resume; never rewrites/advances the request. Every resume revalidates authenticated admission/signer authority after recovery inventory reads, then checks ref immediately before dispatch.
- Stable/checklist wrappers relay verified helper recovery advice, never infer safety from raw uncertainty. Run offered explicit resume, then rerun wrapper. Attempted/uncertain FRV POST stays observation-only; never retry. Preserve original producer/current consumer identities in reuse.

### Routes and frozen context

- Regular `release/*` validation must include `target_context_ref` (helper `--target-ref`); never raw-dispatch without it. Canonical `release/*`/`extended-stable/*` workflow refs remain supported; Telegram must retain exact parent workflow ref/SHA through OIDC and attestation.
- Trusted-workflow release-branch CI passes `target_ref` + `release_candidate_ref`, never `release_gate` (requires workflow head == target). PR-head `ci.yml` fallback below is different and uses `release_gate=true`.
- A frozen Code SHA may precede an advanced canonical release branch only if still its ancestor and package version is the branch's final version or matching beta prerelease. Extended-stable branches/all tags require exact package-version match.
- Fresh qualification: Q=C or explicit reviewed main-ancestor `--workflow-sha <Q>` on candidate route; pass P separately. Missing contracts require deliberate Q repair/candidate backport, never main fallback. Tooling-only repair: [new admission](../../../docs/reference/full-release-validation/dispatch.md#recover-qualification-tooling-without-changing-the-candidate), unchanged C/new request.
- Historical/cross-revision route: `--trusted-workflow-ref main --workflow-sha <recorded-main-tooling-sha>` (or protected tooling tag). New requests allow diagnostic, main-qualification, postpublish-confidence only—not publish qualification. Existing historical publish requests reopen before that restriction, keeping original trusted-main ancestry contract; they are not candidate-owned evidence. Never refresh recorded identities from moving main. Reuse stays enabled unless operator chooses `-f reuse_evidence=false`.

### Release notes and publication bytes

- Notes committed before fresh full qualification: retain Code SHA as Release SHA, same successful parent/attempt, exact prepared bytes for candidate/publication checks. Required gates/final channel-specific SDK review still apply. Publishers consume sealed acknowledgement; candidate helper retains explicit argument when needed.
- Notes changed afterward: commit selected entry/permitted record/index updates; optionally run helper with reuse on new Release SHA. Require `policy=split-changelog-release-v1`, `evidenceSha=<code-sha>`, complete `changedPaths`:
  - Required `CHANGELOG/YYYY.M.PATCH.md`; optional `CHANGELOG.md` and `CHANGELOG/records/YYYY.M.PATCH.md` only.
  - Entry/record additions or modifications; index modifications only. Renames, deletions, other releases, or docs-source edits require fresh product qualification.
  - Historical root-only receipts retain `changelog-only-release-v1`. Reuse product matrix rather than dispatch child lanes; npm preflight/package/install acceptance still test exact Release SHA/new tarballs.
- Current all-group FRV also owns read-only core and selected-plugin npm source/build/qualification and Docker preparation. Use successful run as `preflight_run_id` (candidate helper default); no second npm preflight except historical separate-evidence recovery.
- Regular final qualification records SDK reports for `beta` and `latest`; review actual channel acknowledgement. Prepared descriptors live in `publicationArtifacts`. Release Prepare adopts the manifest's plugin npm descriptor and prepares only ClawHub; it never repacks plugin npm after FRV. Reusing product evidence never substitutes Code-SHA packages/images for Release-SHA bytes.
- Failed independent npm qualification: `pnpm frv continue --failed` retries failed npm jobs on original run, carries successful preparation/diagnostic children, and verifies receipts in parent. Failure alone does not reject continuation. Frozen workflows retain original receipt logic; local controller upgrades do not retrofit it. Final verification owns recovery result.
- SHA-pinned helper infers beta for matching beta candidates, stable for stable/correction versions, and passes C/Q/P. Canonical beta `all` without soak uses `npm-beta-v1`; main/non-beta targets cannot. Run deferred native, performance, Telegram, broad live QA/E2E postpublish against exact package with `run_release_soak=true` or explicit groups. Stable/full force soak. Native publication retains build/signing/notarization/promotion gates. After focused fixes use a narrow `rerun_group`, never automatic widening.
- At seal, parent records SDK evidence digest from qualified npm receipt and resolves per-package npm plans against registry. Manifest `publishInputs` supplies publisher/preflight defaults. SDK API changes still need operator acknowledgement; evidence grants no authority. Mutation owners recheck live authority, selectors, immutable bytes.

### Publication requirements

- Publish with `release_profile=from-validation` (sealed profile). Selected FRV must **succeed**; stable needs stable/full evidence, soak, blocking performance.
- Decide blocker/flake for every failed test. Same-Release-SHA flakes: at most two reruns plus main fix-in-parallel issue/PR, never flake-only re-cut.
- An eligible exact failed leaf may receive a reviewed [release-tooling grant](../../../docs/reference/full-release-validation/evidence.md#release-tooling-waivers). Land/pin P, then run/revalidate FRV without changing C/Q. Publisher cannot grant waivers or accept failed FRV. Unwaived failures and missing/skipped/cancelled/unknown required coverage block.

### Publish children

Use [publication recovery](../release-openclaw-maintainer/references/publication-recovery.md) for ordering and prepared/direct recovery.

- One `pnpm release:watch --run <parent>` per publish parent ([contract](../../../docs/reference/RELEASING.md#watch-publication)); no custom monitor. Reports parent/child environment gates, failed runs, failed `continue-on-error` jobs; backs off on rate limits.
- `pnpm release:stable <version>` ([orchestrated stable release](../release-openclaw-maintainer/references/regular-release.md#orchestrated-stable-release)) dispatches parent once, approves parent `npm-release`, prints child approvals only for older tooling without `npm-publish` and stale-child sweeps when needed; never mutates child runs. Every refusal prints exact recovery command under `Next:`.

#### Approval receipts

- Parent `npm-release` approval mints attested `openclaw-release-approval-v1-<parent run>-<attempt>`. Bot children verify via `scripts/release-approval-receipt.mjs verify` before gates: one human approval per release.
- Verified ClawHub OIDC child skips `clawhub-plugin-release`, then uses its own publication authorization. Core completion/failure must not strand authorized ClawHub; retain lane-local live-authority/exact-byte checks.
- npm children (`Plugin NPM Release`, `openclaw-npm-release.yml`) skip `npm-release` approval on verified route and publish in trusted-publisher-bound `npm-publish`. Immediately before publication, wait for parent attempt's receipt and require that attempt `in_progress`.
- `npm-publish` has no reviewers; admits only protected `release-publish/<sha12>-<n>` tags. Real manual/recovery npm dispatches require that tooling tag and their own `npm-release` approval. Read-only OIDC preflight also uses `npm-publish`/tag; artifact-only preflights retain refs/no environment.
- Never hand-approve `plugin-clawhub-release.yml`: bot route is receipt-verified, no approval. Missing `openclaw-clawhub-recovery-approval-<run>-1` artifact is a nonfatal probe. Historical parent-bound failure `parent state completed/failure is not allowed by authorization route` (2026.9.6, runs **35930335388/35930341394**): use [explicit recovery](../release-openclaw-maintainer/references/publication-recovery.md#interrupted-preparation-and-publication), never hold/redispatch core. Bootstrap `plugin-clawhub-new.yml` always waits on `clawhub-plugin-bootstrap`; approve after secretless pack jobs ([first package](../release-openclaw-maintainer/references/first-package.md)).

#### ClawHub recovery

Historical awaited v2 children could stage most packages, then one failure failed parent and prevented sibling finalization. New publication isolates this to ClawHub:

- Reconcile original child's `*-publish-json` artifacts before republishing/resuming parent.
- `pnpm release:clawhub-recovery -- --version <version> --reason '<parent failure>' --clawhub-source <isolated pinned ClawHub checkout> <package-publish.json>...` prints exact attempt recovery commands; recovery guide owns pinned source CLI/authorized execution.
- Public version 404 does not distinguish staged/missing; attempt status needs publisher auth. Parent receipts/live-authority revalidation still required; recovery never makes failed parent successful evidence.

#### Stale children

- Before npm dispatch, parent sweeps selected failed-parent `waiting`/`queued` npm children for the same release: core by `parent=<run>/<attempt>` title; plugins by Release SHA, only with no other live publish parent. Independent ClawHub lane owns its sweep.
- Each owner tries gate rejection/cancellation and waits up to **5 minutes per workflow**. Rejection 403 needs reviewer; logs/summary provide reject/cancel commands. Unconfirmed cancellation warns. Core's independent slot/live-parent recheck avoids blocking; target-serialized plugin npm refuses new dispatch until cancellation confirmed.
- ClawHub reconciliation/serialized slots/guards remain independent: never hold npm dispatch/core completion or cancel authorized ClawHub because core parent failed. Core failure cancels its waiting npm children. Detached ClawHub parent failure rejects recorded child's pending gate before cancellation; unconfirmed rejection warns with reviewer commands.
- Reviewer cleanup of confirmed stale, no-longer-authorized children: list this release's `workflow_dispatch` runs by `github-actions[bot]`, reject gate, cancel:

  ```bash
  for s in waiting queued; do gh api "repos/openclaw/openclaw/actions/runs?status=$s&per_page=100" \
    --jq '.workflow_runs[] | select(.event=="workflow_dispatch" and .actor.login=="github-actions[bot]") | select(.name | test("plugin-clawhub|Plugin NPM Release|openclaw-npm-release")) | [.id,.name,.created_at] | @tsv'; done
  env_id=$(gh api repos/openclaw/openclaw/actions/runs/<child>/pending_deployments --jq '.[0].environment.id')
  gh api -X POST repos/openclaw/openclaw/actions/runs/<child>/pending_deployments \
    -f state=rejected -f comment="Reject stale release gate" -F "environment_ids[]=$env_id"
  gh run cancel <child> --repo openclaw/openclaw
  ```

- Plugin npm `gh run rerun --failed` breaks attempt-bound preflight artifact readback. Parent waits for original child settlement and propagates failure, without replacement dispatch. Diagnose/fix owner before explicit recovery; preserve successful immutable packages/evidence.

### Extended-stable validation

For `.33+` use candidate-owned helper: exact frozen branch-tip C; Q=C or explicit reviewed main ancestor owning full qualification closure; independently trusted P admits/verifies. Canonical `extended-stable/YYYY.M.33` supplies context, not workflow authority. Deliberately repair Q/backport missing contracts, never silently follow main.

```bash
VALIDATION_SHA="<exact-candidate-sha>"
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
CONTEXT_REF="extended-stable/YYYY.M.33"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref "$CONTEXT_REF" \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  -f validation_purpose=publish \
  -f publication_selection_json='{"route":"extended-stable","npmDistTag":"extended-stable","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}' \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f fail_fast=false \
  -f rerun_group=all \
  -f reuse_evidence=false \
  -f dispatch_release_evidence=false
```

- Helper freezes npm baselines before admission. Primary cross-OS/survivor upgrade baseline: newest published extended-stable below candidate (**2026.8.35 → 2026.9.33**). Survivor set also keeps frozen month's newest stable predecessor (**2026.9.9**). Extended-stable upgrades exercise old updater's real `extended-stable` selector against loopback candidate registry, never explicit `--tag`.
- Only the helper creates the immutable post-admission `release-ci/<Q-prefix>-<timestamp>` transport. Never raw-dispatch, manually create its ref, or mint a Q protected publication tag. Historical cross-revision publish requests retain original identity, never candidate-owned labels. A new explicit main/protected route is diagnostic, main-qualification, or postpublish-confidence only; it cannot replace this admitted C/Q/P publish proof.
- Require complete `rerun_group=all` with supported exact-target manifest. Bind workflow SHA separately from C; manifest target, package versions, saved `run_attempt`, final tag must identify same candidate. Reject narrow runs, untrusted tooling, target mismatches, earlier attempts.
- Parent prepares core/selected-plugin tarballs into immutable `publicationArtifacts`; publish those exact artifacts/attempts. Standalone npm/plugin preflight is diagnostic, never manifest-bound replacement.
- Product failure needs approved backport; frozen-target tooling failure needs smallest behavior-preserving repair. Provider/approval/runner/log races keep candidate unchanged. Record repairs/superseded runs; every branch change needs new complete parent. Omit only explicitly unsupported frozen-target scenarios, never required behavior/package.

### Frozen-target test omissions

| Initial-dispatch JSON array                    | Exact allowed paths/lane                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| `plugin_prerelease_node_exclude_patterns_json` | `src/plugins/` tests, Plugin Prerelease Node            |
| `extension_test_exclude_patterns_json`         | `extensions/` tests, Plugin Prerelease extension shards |

- Normal CI does not own this sweep. Both default `[]`; no implicit Codex omission. Retain justification/owning fix; omitted coverage = not run.
- Preflight must discover every requested path in selected frozen lane. Nonexistent/out-of-lane/duplicate/basename/glob inputs fail loudly.
- Trusted tooling excludes exact inline Vitest leaves, preserves candidate runtime preparation, then restores config bytes. No CLI `--exclude` or new target-side environment variable: frozen inline projects may ignore them.
- Inputs remain in immutable request, coverage/reuse identity, final manifest. Changes require new request, never continuation.

## Watch

Use the attempt-aware controller:

```bash
pnpm frv watch --run <full-release-run-id>
```

- Resolves IDs from parent dispatch logs (`Dispatched <workflow>: <url> (attempt N)`), never display titles. Reports every parent/child attempt transition and failed job once, with runner labels.
- Retries transient GitHub 5xx/HTML bodies next poll, never as job results.
- State: `$TMPDIR/openclaw-frv/<repo>-<parent>-watch.json` (`--state` overrides). Harness/Monitor timeout restarts do not re-report. `--once` snapshot; `--interval <seconds>` (default **60**); `--json` NDJSON.
- Newly observed current-parent/artifact-producer blocker or policy-blocking carried failure: save notification, exit **1**. Resume same command/state for diagnostics without duplicates. Otherwise exits when parent/all dispatched children terminate; restart after later rerun. Use `status` for structured blockers, `continue --failed --dry-run` to preview recovery. No custom bash/`gh` watchers.
- Candidate events use frozen SHA/context from sealed plan, not monitor prose/tooling SHA. Read tip freshly: changed tip labels candidate superseded, but observation continues and never qualifies new tip. Missing evidence/SHA-only context stays unknown.
- Resume missing/exited watcher with same command/state: read-only, suppresses prior terminal/candidate events. Never redispatch to restore watching.

Release Decision transition-only watcher:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id> --watch
```

- Do not start while SHA-pinned helper owns foreground; helper reads exact Decision artifact itself.
- On `blocked_diagnostics_running`, helper exits nonzero immediately, retains temporary workflow ref, and leaves Drain collecting terminal evidence. For separately dispatched parents, summary watcher likewise reports blocker once/exits while Drain continues.

One-shot snapshot:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id>
```

- `release-ci-summary` accepts FRV parents only. Diverged release-branch logs: `--first-parent` plus bounded count. Stop watchers before turn end/strategy change.
- PR/child gates: inspect exact workflow run, not `commits/<sha>/check-runs` (retains superseded/cancelled entries; stale failures can mask success). Resolve newest head `CI` via `actions/runs?head_sha=<sha>`, read its `openclaw/ci-gate` jobs before retry/report.

| State                         | Meaning/action                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `qualifying`                  | No decisive blocker; selected children active.                                                                                                                           |
| `blocked_diagnostics_running` | Publish blocked, Drain collecting independent failures. Diagnose now; `frv rerun`/`continue --failed` once failed child terminal. Final reseal awaits complete evidence. |
| `passed`                      | All required policy/exact-child evidence passed.                                                                                                                         |
| `blocked_complete`            | Publish blocked; selected diagnostics terminal.                                                                                                                          |
| `orchestration_error`         | GitHub API/collector prevented verdict, not proof of wrong source. Recover collector against same exact children; never redispatch tests for collection.                 |
| `cancelled_with_children`     | Collector cancelled with exact children active.                                                                                                                          |

Read actual conclusions for every selected lane. `passed` requires pinned P's policy, terminal evidence, retained raw waived failures. Omitted coverage is not run, never passed.

- Terminal failures/timing: `full-release-diagnostics-<run-id>-<attempt>`. After early blocker, read it rather than restart all just to discover remaining failures.
- Collector identity: stable `full-release-execution-plan-<run-id>`; retries first restore immutable run-ID-cached bytes.

## Failure Triage

1. Confirm parent SHA/child IDs.
2. `pnpm frv watch --run <parent> --once` lists failed jobs with attempts, runner labels, URLs.
3. Fetch one failed-job log. If rate-limited, record reset time; stop REST calls.
4. Secret-looking failure: prove real completion from same secret source before code edits; model-list success is insufficient. Claude CLI subscription auth is separate: clean-home CLI probe, never substitute for required Anthropic API-key lane.
5. Live cache: distinguish missing/invalid key, empty text, provider refusal, timeout, baseline miss. Never weaken release gates without clear provider evidence.
6. Before edits, decide blocker/flake per failed test. Preserve diagnostics, inspect **every same-SHA attempt**, and run:
   - `git log <previous-release-tag>..<release-sha> -- <failing paths>` (candidate delta).
   - `git log <release-sha>..origin/main -- <failing paths>` (main-only changes).
   - A repair on main but absent from the frozen candidate means blocker: backport/supersede, never rerun as inherited success. Same job/signature must have passed on exact Release SHA to call flake; repetition on another candidate stays deterministic until named mechanism/fix. Track genuine-flake fix on main; every unwaived selected job must pass pinned P's publication policy.

| Blocker                                                                                  | Recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed product/code                                                                   | Fix release branch, freeze new Code SHA, invalidate product evidence.                                                                                                                                                                                                                                                                                                                                                                                               |
| Qualification harness/contract                                                           | Keep C; tooling-only repair, new admission/request with reviewed main-ancestor Q and successful parent. Preserve superseded evidence/invalidation reason.                                                                                                                                                                                                                                                                                                           |
| P-only admission/verifier/publisher                                                      | Keep C/Q/original artifacts; repair independent trusted P and affected surface.                                                                                                                                                                                                                                                                                                                                                                                     |
| Infrastructure/credentials                                                               | Keep C/Q/P; repair external prerequisite, retry failed surface only.                                                                                                                                                                                                                                                                                                                                                                                                |
| Wrapper/monitor                                                                          | Keep child/candidate identities; record wrapper result separately.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Changelog/notes                                                                          | Change selected entry/permitted record/index only under `split-changelog-release-v1`; retain Code-SHA evidence, repeat Release-SHA proof.                                                                                                                                                                                                                                                                                                                           |
| Publish child/registry selector                                                          | Keep Release SHA, resume failed child; never rebuild published immutable version.                                                                                                                                                                                                                                                                                                                                                                                   |
| Parent failed after core npm (e.g. stale `beta` dist-tag completion verification)        | Keep successful original npm run/qualified bytes; repair selector; reconcile exact failed-parent children before route resume. Direct finalization normally waits for npm/Docker verification; prepared button retains core checks. Neither waits for ClawHub downloads. Never manually undraft around core gates. [Direct resume/new prepared-button recovery](../release-openclaw-maintainer/references/publication-recovery.md#published-version-failed-parent). |
| Child `waiting`, ClawHub `Artifact not found`, `ClawHub dispatch blocked by waiting run` | [Publish children](#publish-children).                                                                                                                                                                                                                                                                                                                                                                                                                              |

Only product defects require changing C; qualification repairs may change Q via new admission. Reassess after one diagnosis/fix/narrow retry, not another automatic all-group cycle.

7. Runner routing:
   - FRV CI/Plugin Prerelease: hosted `ubuntu-24.04` (or release group). Other lanes follow `OPENCLAW_CI_RUNNER_BACKEND`: `github` moves them off Blacksmith during outage, except QA Lab runtime-pair fails hosted and stays queued on Blacksmith.
   - Release Checks prints `Release runner routing` during flip. Codex extension tests use file-bounded Plugin Prerelease jobs (hosted batch took **36–60 minutes**).
   - Repeated npm-preflight Blacksmith loss: fresh FRV with `-f npm_preflight_use_github_hosted_runners=true`, not repo-wide flip.
8. Required PR CI queued with **no active jobs**: do not cancel unrelated work or accept generic manual dispatch.
   - Verify current fallback schema on PR head: `gh api 'repos/openclaw/openclaw/contents/.github/workflows/ci.yml?ref=<pr-head-branch>' --jq .content | base64 --decode | rg -q 'pull_request_number:'`.
   - If absent, refresh head from main, use new SHA, and let normal CI run before fallback.
   - Dispatch from head branch: `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f target_ref=<full-pr-sha> -f pull_request_number=<pr-number> -f include_android=true -f release_gate=true`. Hosted fallback is accepted only with title `CI release gate <full-pr-sha>`. Ledger stalled Blacksmith/fallback runs.
   - If sole remaining gate `Blacksmith Build Artifacts Testbox` is still queued runnerless, completed exact fallback can cover it: `build-artifacts` already builds/packages/smoke-tests artifacts. Not after artifact workflow starts or completes non-successfully.

## Evidence

Record:

- Lifecycle: regular Code/Release SHA; extended-stable canonical branch/exact SHA/immutable tag. Both: C/Q/P, original admission descriptor, retained request.
- Reuse policy, coverage policy, complete changed paths.
- Active full-parent URL/attempt/workflow SHA; superseded parents/exact replacement reasons.
- Selected child IDs/conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance. Deferred confidence = not run.
- Terminal-manifest core/plugin npm publication artifact descriptors.
- All selected lane conclusions, including Linux/Windows/macOS cross-OS.
- Performance comparisons with earlier releases when available; targeted local proof commands.
- Frozen-target compatibility repairs/omitted inapplicable scenarios, source PRs/invariant.
- Hosted proof/deployment prerequisites separately from local contracts: mocks cannot prove Actions admission, OIDC, environment access, publication.
- Known gaps/unrelated failures.

Lessons/recovery patterns: `references/release-ci-notes.md`.
