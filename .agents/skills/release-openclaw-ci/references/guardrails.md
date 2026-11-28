# Release CI: guardrails

## Guardrails

### Scope and authority

- **Ask first:** version bumps, tags, npm/GitHub releases, and release promotion need explicit operator approval.
- After compaction, resume, or steering, restate the effective goal/phase from the latest explicit instruction. Do not restore superseded scope.
- Once a release branch or Code SHA exists, validate and ship that release—not moving `main`.
- **Frozen-Code firebreak:** admit only confirmed product/security defects, wrong or unverifiable package bytes, or publication blockers. Queue other findings for postpublish confidence/next beta.
- Dependency advisories are evidence, not firebreak admissions: queue bumps on `main` after publication. Only known malware stops publication.
- Touch `main` only for operator-requested changes or the smallest critical main-owned release blocker that cannot be handled on the release branch. Main CI health does not gate release.
- For tooling landings blocked by unrelated main failures: reproduce on clean `main`, record in the PR, and merge. Admin merge is allowed for that exact case during a release; fix red main in a separate parallel lane.
- Tooling-only PRs: add `release-fast-lane` **before pushing**; follow [Release tooling fast lane](readiness.md#release-tooling-fast-lane) and [native review/landing](../../openclaw-pr-maintainer/references/landing.md). The label narrows `openclaw/ci-gate`, not review or landing rules.

### Frozen identities and qualification

- Record **C** (candidate), **Q** (qualification), **P** (admission/aggregate/verifier/publisher), rerun group, profile, effective soak, and context/transport refs. Code SHA and Release SHA are lifecycle roles, not extra workflow identities.
- Default **Q=C**. Freeze C/Q; select trusted P on main or a protected publication tag. C need not be P's ancestor. Executable Q must be reviewed with verified tooling lineage; authorized grant-only descendants follow the Q ledger procedure.
- Q owns the complete workflow/reusable-workflow, action, script, planner, contract, harness, and coverage closure. Q also owns the pinned grant ledger; P owns aggregate evaluation, not grant data. Future-main checks/scenarios are not implicit requirements.
- Missing contracts need a deliberate Q repair or candidate backport; never substitute moving main. Q-only repair may preserve C, but needs new Q, request/admission, and a successful parent. Never edit an old request or relabel failed FRV. P-only repair can preserve C/Q and valid original evidence.
- Candidate tags: absent is allowed; existing lightweight/annotated tags must resolve to exact C. Conflicts or failed remote lookup stop validation; never move a tag to recover.
- Protected lightweight `release-publish/<12sha>-<provenance-run>` tags identify P, not Q. Suffix = tag-creation provenance, not current parent. Publication/checklist `--workflow-sha` selects **P**; FRV `--workflow-sha` selects **Q**.
- Unless an exact human-approved fast-track packet is supplied, FRV must succeed with P evaluating pinned Q’s [waiver policy](../../../../docs/reference/full-release-validation/evidence.md#release-tooling-waivers); every other required lane must pass. [Stable publication](publication.md#publication-requirements) needs stable/full evidence, mandatory soak, and blocking performance. Beta proof cannot qualify stable; only checked-in performance exceptions apply.
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
- One release operator, one [`pnpm frv watch --run <parent>`](watch-and-triage.md#watch), at most one investigator for the current failure. No audit/review/plan trees for one transition.
- Fetch only failed/currently blocking job logs. Avoid broad `gh run view` polling; when quota is low, wait for reset.

### Plans, attempts, and recovery

- FRV separates child dispatch, Release Decision, and Diagnostic Drain. `fail_fast=false` makes **zero** child-cancellation calls; Drain follows selected children to terminal unless cancelled itself or denied GitHub API access. `fail_fast=true` may cancel only the exact active child owning a blocker.
- Same-parent continuation requires the root's original logged `fail_fast=false`; the controller checks before mutation.
- A parent that sealed its own candidate artifacts cannot use same-parent continuation: reruns make prior-attempt artifacts unavailable. Before starting fresh all-group FRV, assess [receipt-backed aggregate recovery](recovery.md#receipt-backed-aggregate-recovery) with frozen C/Q and the original receipts.
- One immutable execution-plan artifact seals original parent attempt, exact child tuples/titles, coverage, gates, and reuse identity; identical bytes are cached by exact run ID. Decision, Drain, manifests, evidence validation, and final verification consume the current attempt's artifact.
- Collector retry: restore/validate cached plan, re-upload, adopt the same children. Missing plan is orchestration failure—not permission to reconstruct or redispatch. If same-parent recovery is unavailable, use the [receipt-backed recovery decision](recovery.md#receipt-backed-aggregate-recovery), not another blind parent retry.
- Before `passed`, Decision rechecks reused evidence: sealed target/evidence SHAs, policy, changed paths, selected/root runs, source manifest, trusted tooling identity, and exact children. Sealing alone is not trust.
- Parent retry selects newest Decision and Drain independently; both must bind the same immutable plan even if source attempts differ.
- Child retry stays in-plan only with exact run ID, workflow path/ref/Q, dispatch title/event, target, candidate, and validation inputs. Newer attempts replace matching jobs; absent jobs carry forward. Duplicate identities, missing/regressed attempts, or changed tuples fail closed.
- `frv status`/`continue` allow **60 seconds** of read-only reconciliation for transient newest-attempt duplicate jobs. Tuple/attempt stay pinned; persistent duplicates and older-attempt conflicts remain errors.
- Use `pnpm frv status|watch|rerun --job|rerun --child|continue --failed|verify`. Controller is stateless; plan, exact GitHub attempts, Drain, and final manifest are authorities. It never writes tags, packages, registry entries, release candidates, or publications.
- **Post-merge controller proof:** use reviewed landed SHA on protected main through non-release `FRV Proof Broker` + `FRV Proof Fixture`, never real FRV. Dispatch broker with merged PR and exact landed commit; require PR merge commit equality and landed commit equal/ancestor of trusted workflow SHA. Recheck authority, merge, and ancestry immediately before fixture rerun.
- Require the exact fixed no-op fixture to change intentional attempt-one failure → attempt-two pass; the broker emits its receipt. No release candidate/artifact/publication/ref/replacement parent or other workflow mutation. Hosted proof covers targeted-job rerun; focused tests cover immutable-plan eligibility, green-attempt preservation, same-parent collection, and strict-verifier invocation. See [continuation proof](https://docs.openclaw.ai/reference/full-release-validation#post-merge-continuation-proof).

### Isolated checkouts and Testbox

- Sparse worktree/Testbox sync: verify `package.json`, `pnpm-lock.yaml`, and **every** selected-check input. Missing inputs → use remote changed gate/full task worktree, not dependency/Docker validation from that checkout.
- If inputs exist and package/lock changes, rebuild only the task-owned disposable box with `CI=true pnpm install --frozen-lockfile`; then probe `require.resolve()` before Docker/focused tests. `CI=true` permits noninteractive recreation of prewarmed modules. Never weaken locks or call sparse failures product/Docker defects.
- Candidate rebased/base changed after warmup → stop the task box and warm a fresh one. Relative source sync can otherwise mix old-base files with new diffs and create false lock/Docker failures.
- Reused Testboxes check recorded source after first successful run. Source-only edits can reuse; base/dependency/wrapper/workflow drift needs a fresh lease. Never use `OPENCLAW_TESTBOX_ALLOW_STALE=1` for release proof.
- Supported committed-candidate capsule: from C's checkout, run `node scripts/crabbox-wrapper.mjs run --blacksmith-ref main -- <command>`. Capsule preserves C/dependencies; main supplies admission limits. If wrapper contract is absent, use exact-target release validation with separate Validation/Tooling SHAs. Never dispatch candidate Testbox refs or borrow another checkout's wrapper.
