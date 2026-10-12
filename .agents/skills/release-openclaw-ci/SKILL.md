---
name: release-openclaw-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use this with `$release-openclaw-maintainer` and `$openclaw-testing` when a release candidate needs full validation, install/update proof, live provider checks, or CI recovery.

## Guardrails

- No version bump, tag, npm publish, GitHub release, or release promotion without explicit operator approval.
- After compaction, resume, or new steering, rewrite the effective goal and
  current phase from the latest explicit operator instruction. Do not merge old
  scope back into the active release.
- Hold the release scope once a release branch or Code SHA exists. Validate and
  ship that exact release; do not turn moving `main` into a second work queue.
- Record **C (candidate), Q (qualification), P (admission/verifier/publisher),
  rerun group, profile, effective soak, and context/transport refs**. New
  candidate qualification defaults to Q=C, including the complete workflow,
  reusable workflow, local action, script, planner, contract, and coverage closure.
  Code SHA and Release SHA remain lifecycle roles, not extra workflow identities.
- The candidate helper accepts an absent release tag or an existing lightweight
  or annotated tag resolving to the exact candidate SHA. A conflicting tag or
  failed remote lookup stops validation; never move a tag to recover.
- Freeze C/Q and independently select trusted P on main or a protected
  publication tag. C/Q need not be an ancestor of P. Missing candidate contracts
  require a deliberate backport; never silently substitute newer main tooling.
- Apply a release firebreak after the Code SHA is frozen. Admit only confirmed
  product defects, wrong or unverifiable package bytes, security
  defects, or failures that make publication impossible. Queue other findings
  for postpublish confidence or the next beta. Dependency advisories are never
  firebreak admissions: record them as release evidence and queue the bump on
  `main` after publication; only known malware stops publication.
- Frozen CI children use Q's Node shard planner and measured
  costs, while discovering and executing tests from the candidate checkout.
  Hosted full-release plans split measured rows above 12 minutes; preserve file
  coverage, worker limits, and complete timing generations. An indivisible
  over-budget owner must be split rather than increasing the release budget.
  After the child completes, closeout runs `scripts/ci-shard-timings-refresh.mts`
  for that exact run and commits generated costs; do not hand-edit measurements.
- Candidate qualification runs its own frozen Q closure. Main-only checks and
  future-main scenarios are not implicit release requirements. Fixing a frozen
  qualification harness means a new C/Q, with newly bound evidence. A P-only
  admission/verifier/publisher repair can keep C/Q and their original evidence.
- Protected lightweight `release-publish/<12sha>-<provenance-run>` tags identify
  P, not Q. The suffix records tag-creation provenance, not the current parent.
  Publication helpers retain their `--workflow-sha <P>` argument; the FRV helper's
  `--workflow-sha` instead selects Q and must equal C on the candidate route.
- Touch `main` only for an operator-requested change or the smallest critical
  main-owned blocker that prevents this release and cannot be handled from the
  release branch. Main's CI health never gates a release. If a release-tooling
  landing is blocked by `main` failures it does not cause, prove on a clean
  `main` checkout that the failure already exists there, record it in the PR
  body, and merge; during an active release an admin merge is allowed for that
  exact case. A separate lane fixes red `main` in parallel, off the release's
  critical path.
- Land tooling-only fixes on `main` with the `release-fast-lane` label added
  before the push (see [Release tooling fast lane](#release-tooling-fast-lane)): `openclaw/ci-gate`
  then runs lint, types, guards, dependencies, docs, and the changed Node rows
  only. Land through the native `scripts/pr` path with its completed ClawSweeper
  review; findings are advisory for that label, so record any P1 the release
  owner declines to fix in the PR with its follow-up before landing.
- `OPENCLAW_RELEASE_RUNNER_GROUP` optionally routes validation parents and workers
  and the Release Publish parent plus its publish children to reserved capacity
  with unchanged labels; credentialed publish and approval jobs stay on default
  GitHub-hosted labels. Configure eligible runners and repo
  access first; unset preserves ordinary routing. Shared workers inherit the
  caller group; PR/main CI and unrelated scheduled work remain outside it.
- Check the nightly parent for the Code SHA before dispatching a fresh main validation; it seals per-child receipts that exact-target dispatches adopt when inputs match. The nightly runs this explicit trusted-main helper route (`--sha <main-sha> --workflow-sha <main-sha> --trusted-workflow-ref main`), so its parent runs on a `release-ci/<sha12>-<id>` branch, not `main`.
- Every selected validation lane must pass; see
  [Publication requirements](#publication-requirements). Stable tags require stable/full
  evidence, soak, and blocking performance. Beta-profile evidence cannot qualify
  stable. No lane or soak waiver bypasses these requirements. All-group
  qualification requires all nine Linux/Windows/macOS Gateway install/upgrade
  combinations. Preserve first failures, identity, and complete evidence.
- Native macOS, Windows, Linux, and Android publication is independent of
  npm/ClawHub, GitHub finalization, and main closeout. Each platform retains
  its own signing, qualification, artifact, and updater requirements; report
  pending platforms accurately and repair native-only failures in parallel.
- Do not set GitHub secrets from unvalidated 1Password candidates. If a candidate returns 401/403, leave the existing secret alone and report the exact missing provider.
- Use `$one-password` for secret reads/writes: one persistent tmux session, targeted items only, no secret output.
- Watch one parent run with `pnpm frv watch --run <parent>` (see [Watch](#watch)).
  Avoid broad `gh run view` polling loops; REST quota is easy to burn.
- Fetch logs only for failed or currently-blocking jobs. If quota is low, stop polling and wait for reset.
- Treat live-provider flakes separately from code failures: prove key validity, provider HTTP status, retry evidence, and exact failing lane before editing code.
- When diagnosing a live-provider failure, a model-list response proves
  authentication, not billing or inference entitlement. Confirm the credential
  with a real completion probe before treating it as valid. Fix the credential
  first; do not add an alternate auth path merely to bypass a failed release
  credential.
- Full Release Validation separates exact-child dispatch, Release Decision,
  and Diagnostic Drain. With `fail_fast=false`, it makes zero child
  cancellation calls; Diagnostic Drain follows every selected child to
  terminal unless the collector itself is cancelled or loses GitHub API
  access. With
  `fail_fast=true`, Release Decision may cancel only the exact still-active
  child that owns a blocking failure.
- Same-parent continuation requires the original root to have been dispatched
  with `fail_fast=false`. The controller verifies that exact logged input
  before any rerun mutation.
- A parent that produced its own sealed candidate artifacts cannot be continued:
  GitHub reruns make those prior-attempt artifacts unavailable. Keep the
  candidate and qualification SHAs frozen, supersede that parent, and start a fresh
  all-group Full Release Validation.
- After dispatch, one immutable execution-plan artifact records the original
  parent attempt, exact child tuples and titles, selected coverage, gates, and
  reuse identity. The same bytes are saved under an exact run-ID cache key.
  Decision, Drain, manifest writing, evidence validation, and final verification
  consume the artifact for their current attempt. A collector retry restores
  the cached plan, validates it, re-uploads its artifact, and adopts the same
  children; missing plan state is an orchestration failure, not permission to
  reconstruct the plan or redispatch.
- Reused evidence is not trusted merely because plan sealing found it. Release
  Decision repeats the sealed target SHA, evidence SHA, policy, changed paths,
  selected run, root run, source manifest, trusted tooling identity, and
  exact-child checks before returning `passed`.
- Parent retries select the newest Decision and Drain artifacts independently;
  both must bind the same immutable plan even when their source attempts differ.
- Child retries are part of the same immutable plan only when the child run ID,
  workflow path, ref, Q SHA, dispatch title, event, target, candidate, and
  validation inputs remain exact. Newer child attempts replace matching jobs;
  jobs absent from a newer attempt carry forward. A duplicate job identity,
  missing attempt, regressed attempt, or changed tuple fails closed. `frv status`
  and `continue` allow up to 60 seconds of read-only reconciliation when GitHub
  temporarily returns duplicate jobs in the newest retry attempt. The run tuple
  and attempt stay pinned; persistent duplicates and older-attempt conflicts
  remain errors.
- Use `pnpm frv status|watch|rerun --job|rerun --child|continue --failed|verify` for attempt-aware recovery.
  The controller is stateless: the immutable execution plan, exact GitHub run
  attempts, Diagnostic Drain, and final manifest are the only authorities. It
  never writes a tag, package, registry entry, release candidate, or
  publication.
- Post-merge controller proof must use the reviewed landed SHA on protected
  `main` through the non-release `FRV Proof Broker` and `FRV Proof Fixture`.
  Dispatch the broker with the merged pull request number and exact landed
  commit. The broker must require that pull request's merge commit to match the
  landed commit, prove the landed commit is identical to or an ancestor of its
  trusted workflow SHA, and repeat authority, merge, and ancestry checks
  immediately before rerunning the fixture.
  Require the exact fixed no-op fixture run to advance from its intentional
  attempt-one failure to an attempt-two pass. The broker must emit its receipt
  without creating a release candidate, release artifact, publication,
  repository ref, replacement parent, or other workflow mutation. This is the
  hosted GitHub targeted-job rerun proof; focused controller tests own immutable
  plan eligibility, green-attempt preservation, same-parent collection, and
  strict-verifier invocation. Never use a real Full Release Validation run for
  this proof. See
  [Full Release Validation](/reference/full-release-validation#post-merge-continuation-proof).
- Use one release operator, one `frv watch`, and at most one
  investigator for the current failed surface. Do not build audit-review-plan
  trees around a single workflow transition.
- For regular beta/stable releases, Code SHA may already contain final notes
  and serve as Release SHA. One successful fresh full parent may qualify both
  roles and their exact publication bytes. If notes change afterward, a later
  Release SHA may reuse product evidence only when its complete delta from
  Code SHA changes the selected `CHANGELOG/YYYY.M.PATCH.md` and optionally
  `CHANGELOG.md` and `CHANGELOG/records/YYYY.M.PATCH.md`, with no other paths,
  renames, or deletions; its changed bytes still need qualification.
- Extended-stable validates one exact branch tip; it does not reuse the regular
  Code-SHA/Release-SHA evidence model.
- In a sparse worktree or Testbox source sync, first confirm `package.json`,
  `pnpm-lock.yaml`, and every source path the selected check reads. If any are
  absent, that checkout cannot validate a release dependency or Docker lane:
  stop and use the repo remote changed gate or a full task worktree. When the
  inputs are present and a release fix changes `package.json` or
  `pnpm-lock.yaml`, rebuild only the task-owned disposable box with
  `CI=true pnpm install --frozen-lockfile`, then run an explicit
  `require.resolve()` probe before Docker or focused tests. The CI flag permits
  pnpm to recreate a prewarmed modules directory without an interactive
  confirmation. Do not weaken the lockfile or label sparse-checkout failures
  as product/Docker failures.
- If the candidate is rebased or its base SHA changes after warmup, stop the
  task-owned box and warm a fresh one before testing. Testbox source sync is
  relative to the warmed source tree; continuing can mix an old base file with
  a new candidate diff and produce false lockfile or Docker failures.
- Reused Testboxes are checked against their recorded source after their first successful run.
  Source-only edits may reuse the lease; base, dependency, wrapper, or Testbox
  workflow drift requires a fresh lease. Do not set
  `OPENCLAW_TESTBOX_ALLOW_STALE=1` for release evidence.
- For a committed release candidate with the supported capsule-aware wrapper,
  run `node scripts/crabbox-wrapper.mjs run --blacksmith-ref main -- <command>`
  from that candidate's checkout when using Testbox. The capsule preserves
  candidate source and frozen dependencies while `main` supplies current
  admission limits. If the candidate lacks that wrapper contract, use the
  exact-target release-validation route below with separate Validation and
  Tooling SHAs. Do not dispatch candidate Testbox workflow refs or borrow
  another checkout's wrapper.

## Deferred CI recovery

Release validation does not pause CI or supporting workflows. The legacy
`OPENCLAW_RELEASE_PRIORITY_RUN` variable is ignored by current workflow
admission, and `pnpm frv prioritize --run` is retired. Use
`pnpm frv prioritize --restore <record>` to recover runs deferred by older
workflow revisions and clear their variable.
Keep the required publication proofs and soak gates intact.

## Continuous release readiness

The scheduled main validation (every 3 hours at :07 UTC) seals a direct-root manifest and per-child receipts for the exact main SHA.
For a same-day cut, land the release train on `main` (version and changelog) before the next scheduled run,
then cut `release/YYYY.M.PATCH` at that run's SHA so the Code SHA equals the validated SHA.
Per-child adoption matches exact target SHA, role, and dispatch inputs minus `dispatch_id`:
`productPerformance` is adopted because its inputs are context-free and match.
A stable candidate dispatched with `--target-ref release/YYYY.M.PATCH` resolves
`coveragePolicy=npm-stable-v1` and `ci_release_scope=npm-stable`, versus `full` scope on `main`.
`normalCi`, plugin prerelease, and release checks are re-dispatched because their inputs add
`target_context_ref`, plugin prerelease and release checks add `allow_frozen_target_scenario_omissions=true`, and scope differs.
Whole-parent adoption requires byte-identical manifest `validationInputs`, including `validationPurpose`,
`publicationSelectionJson`, `targetContextRef`, `targetVersion`, `allowUnreleasedChangelog`, and `coveragePolicy`;
a `main-qualification` nightly is never adopted wholesale by a `publish`-purpose stable candidate.
Purpose/context-crossing adoption is a verifier policy follow-up.

## Release tooling fast lane

Add the `release-fast-lane` label to a pull request before the push that should
use it; PR CI reads labels from the triggering event, and label events do not
start CI. For an already-pushed head, `gh pr ready --undo` then `gh pr ready`
re-triggers PR CI with the current labels. The label narrows `openclaw/ci-gate`
only on a canonical pull request whose changed paths are all release tooling:
`.github/workflows/**`, `scripts/**`, `test/scripts/**`,
`.agents/skills/release-*/**`, `docs/reference/RELEASING.md`, or independently
checked documentation. Admitted runs keep `security-fast`, `check-shard` (lint,
prod/test types, guards, dependencies, npm lock), `check-docs` when docs
changed, and the changed Node rows; the compact packing-policy full-plan proof
for planner edits is relaxed to those rows. Contracts, baseline ratchets,
bundled protocol, Bun launcher, additional checks, build artifacts (unless a
changed row needs `dist`), Control UI, Windows, macOS, iOS, Android, i18n, and
skills lanes are skipped and listed under "Release fast lane" in the preflight
step summary. A declined label (out-of-scope path, global Node input, fork,
push, dispatch, docs-only) logs a warning and leaves ordinary selection
untouched. The gate stays complete: every selected lane must pass, and hourly
full main CI covers the merged result. The label narrows only the CI gate: fork
heads are declined, and the native `scripts/pr` landing path with its completed
ClawSweeper review is unchanged. ClawSweeper findings are advisory for labelled
PRs: a P1 that the release owner decides not to fix in the PR is recorded there
with its follow-up before landing.

## Run identity and retry budget

Record C, Q/ref, P/ref, target context ref, parent run id,
attempt, and phase before watching or recovering Full Release Validation. Keep
Code SHA and Release SHA as lifecycle roles in the ledger; they may name the
same commit. Record the
immutable Release Publish parent receipt separately from the tag's recorded source.

For the core and plugin npm mutations enforced by this foundation, re-read the
exact protected lightweight tag and revalidate the exact parent run tuple
immediately before each publish or dist-tag mutation. Reject a missing, moved,
annotated, or wrong-SHA tag; a repository, workflow, run id, attempt, tooling
identity, or parent-state mismatch; and any same-name branch. Never refresh
either identity from current `main`. Treat other privileged writers as blocked
until their dependent enforcement changes land.

- Conceptual phases map to current inputs as follows:
  - `beta-publish`: `release_profile=beta`, `run_release_soak=false`
  - `postpublish-confidence`: published package inputs with
    `run_release_soak=true` or explicit focused groups
  - `stable-publish`: `release_profile=stable` or `full`, with soak and blocking performance
- An `all` run without soak for an actual beta package on its matching canonical
  release branch or beta tag records `coveragePolicy=npm-beta-v1`. It keeps
  Linux/macOS/Windows Node, Control UI, plugin, package, install/update,
  Linux/Windows/macOS cross-OS, QA parity, runtime-pair/restart, and tool coverage.
  All selected tests gate npm/ClawHub. Native app
  CI, performance, and published-package Telegram are deferred to confidence.
  Beta `all` without soak also defers Package Acceptance Telegram, including
  beta-profile checks of `main`. Record deferred checks as not run,
  never passed. Stable/full, soak, and focused groups retain their coverage;
  selected children still require terminal evidence. An absent coverage policy
  retains historical full behavior.
- Keep at most one active parent for the same C + Q + rerun
  group + release profile + effective soak coverage. Stable/full always include
  soak. Distinct coverage profiles can run independently; concurrency does not
  cancel an older exact child automatically.
- Parent cancellation or timeout does not settle independent descendants.
  Preview `pnpm frv cancel --run <parent> --dry-run`, then run it without
  `--dry-run` only for explicitly requested cancellation. The canonical owner
  authenticates the sealed plan, exact dispatch logs, current attempts, artifact
  producers, and recorded Telegram descendants; borrowed/reused children remain
  untouched. Repeat an incomplete result with its next command. Use `--force`
  only when an earlier cancellation is not settling. Never infer ownership from
  branch, title prefix, or latest-run order, or dispatch a replacement before the
  owned tree is terminal.
- Recover one failed surface with one diagnosis, one fix when needed, and one
  narrow retry. Then reassess the release decision. Do not automatically
  dispatch `rerun_group=all`.
- Rerun a failed or timed out test job only after the lead records its
  real-blocker-or-flake decision (see the maintainer skill's shared release
  boundaries). A flake gets at most two recorded reruns on the same Release SHA
  plus a fix-in-parallel issue or PR on `main`; never a re-cut, tooling change,
  or new FRV. New dispatches reject `known_flaky_jobs_json`.
- For a supported parent, `pnpm frv rerun --run <parent-run-id> --job
"<child-key>:<exact job name>"` reruns one executed terminal job using its accepted
  Actions job ID. Get the child key and exact name from `frv status --json`.
  GitHub also reruns dependent jobs. The controller waits only for that child
  before sending the request; it does not retry unrelated failures.
- `pnpm frv rerun --run <parent-run-id> --child <child-key|run-id>
[--max-attempts N]` records one of those bounded reruns. It waits for the
  child to finish, sends exactly one rerun-failed-jobs request, and returns once
  the new attempt exists without duplicate jobs. Before the request it prints
  each failed job's runner labels and the current `OPENCLAW_CI_RUNNER_BACKEND`;
  afterwards it appends an audit line to
  `$TMPDIR/openclaw-frv/<repo>-<parent>-reruns.jsonl`. It refuses a passed
  child, an artifact producer (use `continue --failed`), and a child past its
  attempt budget: the default 2 allows one rerun; pass `--max-attempts 3` only
  for a confirmed flake. When a failed consumer binds a green producer's run
  attempt (the install-smoke candidate payload, #161317), it reruns that
  producer job and its dependents instead. Reseal with `continue --failed`.
- `pnpm frv continue --failed --run <parent-run-id>` reruns each failed child
  as soon as it is terminal, even while the parent or siblings remain active.
  It adopts active attempts and preserves green children. Once every required
  child is green and the original parent finishes, it reruns the parent once
  to restore the same immutable plan and seal the updated all-group manifest.
  An early retry can invalidate the original Decision/Drain pairing; the final
  reseal and strict verification own completion.
- Each child or parent rerun mutation is sent exactly once per invocation;
  ambiguous transport failures trigger bounded read-only reconciliation. Do
  not blindly repeat an interrupted or timed-out command: inspect exact
  attempts first. Targeted JSON results record the job ID, accepted source
  attempt and observed retry attempt. Keep the command in a long-running shell
  for its default 12-hour operation budget.
- Inspect without mutation:

  ```bash
  pnpm frv status --run <parent-run-id>
  pnpm frv verify --run <successful-parent-run-id>
  ```

- Parents whose immutable plan predates attempt-aware evidence cannot be
  continued. Start a fresh all-group Full Release Validation; never reconstruct
  old state or dispatch a replacement parent.

- Controller retries are `ci`, `plugin-prerelease`, `install-smoke`,
  `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`,
  or `performance`. Never use the removed `release-checks` handle. `qa` is
  only a direct-child manual aggregate, not a controller retry API.
- Filtered retries fail closed unless the filter belongs to the selected group.
  All-group runs also accept `cross_os_suite_filter`: for example,
  `-f cross_os_suite_filter=ubuntu,macos` excludes Windows. `npm-stable-v1` and
  `npm-beta-v1` still qualify when explicitly filtered OS lanes are omitted, provided all
  Linux suites remain selected and the other policy requirements hold.
  Never turn an empty derived filter into an unfiltered broad run.
- A new all-group parent is justified only when shared orchestration changed,
  earlier evidence is invalid for the selected tuple, or the operator explicitly
  requests it. Record the invalidating event.
- Narrow child or group evidence does not by itself become publish
  authorization. Keep it in the evidence ledger for the release owner to judge
  against the current publish gate.

## Preflight

Before full matrix dispatch, run both `pnpm ui:i18n:check` and
`pnpm native:i18n:check` against the frozen trusted target in approved isolation.
Bind both results to that exact SHA. Report generated-locale drift as a warning
and continue dispatch; source changes and the serialized locale-refresh workflows
can temporarily leave generated output behind. Do not require regeneration before
starting validation. FRV's normal-CI child retains the strict `control-ui-i18n`
and `native-i18n` jobs and reports their actual results in the run summary;
a failed selected locale job blocks npm/ClawHub publication. PR-side checks and
release-prep gates stay unchanged. Keep target execution outside the trusted
dispatch helper—do not execute an arbitrary target checkout as helper code.

Before expensive full validation, also run `pnpm ui:build` on the same frozen
trusted target with its frozen dependencies in approved isolation, outside the
trusted dispatch helper. Record the target SHA with the successful production
build, precompressed-asset verification, and startup/largest-asset budget results;
any failure blocks fanout. Do not substitute a dev server or raise budgets to admit
the target.

For local full E2E proof, prepare the frozen, dependency-ready proof checkout
with private QA entries in the initial build:

```bash
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build
```

Then run the selected E2E command with its normal readiness checks enabled.
`scripts/lib/vitest-build-prerequisites.mts` requests private QA entries;
`scripts/run-node.mts` triggers another full build when they are absent. This
preflight avoids rebuilding solely for `missing_private_qa_dist`. Keep the flag
scoped to this task-owned proof checkout and command. Publication package and
image bytes remain owned by the release workflows and their sealed artifacts.

Before full release validation:

```bash
gh api rate_limit --jq '.resources.core'
git status --short --branch
git rev-parse HEAD
```

### Before publication

For regular beta/stable protected publication, after evidence validation run
`pnpm release:publish-preflight` with the intended tag, exact Full Release
Validation run and attempt, npm dist-tag, plugin scope, and protected publication
tooling ref. `pnpm release:candidate`
invokes this check with its downloaded manifests; do not redownload them or
replace the selected attempt. Use the report's exact dispatch command for the
chosen publication route only after resolving every `FAIL` and owner-action
`WARN`. Extended-stable retains its separate owner workflows and is not
admitted by this preflight. Alpha releases are retired.

The checklist's `--workflow-ref`/`--workflow-sha` selects trusted P tooling, not
the candidate harness. Reuse authenticated stable package Telegram proof from
the exact FRV-qualified tarball; beta coverage remains deferred. Supplemental
Telegram checks require the retained qualification ref verified at Q=C, with
the harness pinned to C. Never dispatch candidate checks from moving main.
Local Parallels uses C's checkout and dependency graph. Supplemental Telegram
run IDs stay in candidate evidence, not the optional publisher diagnostic input.

Check the report before retrying a failed publication: preserve the verified
`openclaw_npm_resume_run_id` for already-published core bytes, inspect matching
draft/published release state, and identify exact orphaned plugin/ClawHub children
before cancellation. Preflight is read-only and does not authorize publication,
cancel children, or prove a repository secret from local credentials. Bootstrap
candidates need a read-only `npm whoami` probe using the repository's actual
`NPM_TOKEN`; follow the secret-isolated step in
[bootstrap token probe](../release-openclaw-maintainer/references/publication-recovery.md#check-the-bootstrap-token)
and retain its run URL. Do not rotate credentials as part of a diagnostic check.

## Dispatch

After source admission, plugin compatibility readiness, and evidence reuse
selection, dispatch source-only children alongside npm and Docker artifact
producers. Candidate acquisition consumes raw npm bytes while qualification
continues; candidate Plugin Prerelease and Release Checks start immediately
after candidate verification without waiting for independent validation or
Docker. Preserve the immutable execution plan and final artifact qualification.

Each selected validation child uploads an immutable
`full-release-child-evidence-<target-sha>-<role>-<run-id>-<attempt>` receipt from
trusted workflow tooling. The receipt retains normalized dispatch inputs,
including candidate descriptors, and composes predecessor jobs across attempts.
Its `workloadConclusion` excludes the running publisher. Collection failure
loses reuse metadata without changing workload qualification. With
`reuse_evidence=true`, dispatch scans at most 100 recent runs, probes at most 40
target receipt inventories, and fully validates at most five matching receipts
per role within two minutes. Other-target and other-tooling runs do not spend
the full-validation budget. Empty-string inputs equal absent inputs because GitHub omits them from
`github.event.inputs`; non-empty defaults and candidate descriptor bytes must
match exactly. It can adopt green children from failed, cancelled, or active
parents only at the same Tooling SHA as the current parent, still requiring main
ancestry. Missing or different parent tooling fails closed; no paths are exempt.
Dispatch logs identify reused children, explain each evaluated rejection, and
summarize skipped runs and fresh dispatches. The current-parent adoption witness
and immutable execution plan bind each selection. Collectors and final verification
recheck the live child attempt and conclusion, same tooling, main ancestry, inputs,
artifact identity/digest/expiry, and successful trusted seal/upload steps. A newer
attempt invalidates reuse; do not rerun an adopted child to repair a collector.
Current-parent source/publication admission and the separate successful-parent
changelog reuse path remain unchanged. Artifact producers retain their existing
sealed receipts. Candidate admission does not widen this per-child receipt
reuse contract: a divergent Q runs fresh children; whole-parent authenticated
evidence reuse retains its separate original-Q contract.

An early standalone product-performance run is optional beta confidence. If
useful, start it against the frozen Code SHA in parallel with release work:

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

- Do not add a separate mandatory prepublish wait for this optional beta signal.
- Compare available Kova, gateway startup, and CLI startup metrics with earlier
  release evidence or clawgrit reports before publish/closeout.
- Record regressions in release evidence and investigate their product impact.
  Stable/full qualification requires blocking performance. Every selected
  performance child must succeed; failures cannot be waived.
- `npm-beta-v1` defers the performance child. Every selected child still needs
  terminal evidence and must prove artifact-only publication.

Use the canonical helper for reviewed candidate qualification. It alone first
runs the lightweight `admit-qualification` operation on
`openclaw-release-prepare.yml` at P, then dispatches FRV at Q=C. P records the
operator attestation, complete normalized inputs, and data-only frozen Q coverage;
the immutable descriptor travels in the existing `trusted_workflow_json` envelope.
Do not execute candidate code in P's admission step or hand-assemble the envelope.

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

Q defaults to C; an explicit `--workflow-sha` must equal C. P can instead use
an existing protected `release-publish/*` tag with its exact SHA. Review the
candidate and coverage before dispatch: admission records that operator
attestation, not a bot exception. Scheduled main qualification explicitly uses
`--trusted-workflow-ref main` and retains its trusted-main semantics.

An existing `--request-file` reconciles the original request without changing
its route, Q/P identities, or inputs. `--reconcile-request <file>` is read-only.
Only `--resume-request <file>` can continue a candidate request after admission
and before any Q ref mutation or FRV POST. Stable/checklist refusals print that
exact next command for a v2 prepared request whose Q ref is still intended;
run it explicitly, then rerun the wrapper. Reconciliation alone does not advance
an admitted request into qualification. Uncertain writes never retry. Keep
original producer and current consumer identities when reusing evidence.

Select `npmDistTag=beta` for beta publication and `route=prepared` only for an
intended prepared-button consumer. The source-admission result does not qualify
registry state or authorize publishing. Nonpublish investigations use explicit
`validation_purpose=diagnostic` without publication selection; recurring main
qualification uses `main-qualification`, and exact published-package confidence
uses `postpublish-confidence`. Keep coverage/profile selection independent.

For regular `release/*` validation, never raw-dispatch the workflow without
`target_context_ref` (the helper's `--target-ref` records it). Canonical
`release/*` and `extended-stable/*` workflow refs remain supported routes, but
their Telegram child must retain the exact parent workflow ref and SHA through
OIDC and attestation. Trusted-workflow release-branch CI passes `target_ref` +
`release_candidate_ref`; never `release_gate` there — it requires workflow head
== target. (The PR-head ci.yml fallback below is a different dispatch and does
use `release_gate=true`.)

The release branch may advance after the Code SHA is frozen. The helper accepts
that frozen SHA only while it remains an ancestor of the canonical release
branch and its package version is either the branch's final version or a
matching beta prerelease. Extended-stable branches and all tags require
an exact package-version match.
For fresh candidate qualification, retain Q=C and pass P separately. Missing
frozen contracts fail closed and require deliberate candidate backports, not
fallback to main. The explicit historical/cross-revision route remains
`--trusted-workflow-ref main --workflow-sha <recorded-main-tooling-sha>`
(or a protected tooling tag). New requests on this route are diagnostic,
main-qualification, or postpublish-confidence only, never publish qualification.
Existing historical publish requests reopen before this new-dispatch restriction
and preserve their original trusted-main ancestry contract; they are not
candidate-owned evidence. Never refresh either route's
recorded identity from moving main. Evidence reuse remains enabled unless the
operator deliberately selects `-f reuse_evidence=false`.

If final notes were already committed before fresh full qualification, retain
that Code SHA as Release SHA and use the same successful parent/attempt and
its exact prepared bytes for candidate and publication checks. Required gates
and final channel-specific SDK review still apply. Publishers consume the sealed
acknowledgement; the candidate helper retains its explicit argument when needed.

Only if notes change after qualification, commit the selected release entry and
any matching record/index updates, then
optionally run the helper against the new Release SHA with reuse. That parent must report
`policy=split-changelog-release-v1`, `evidenceSha=<code-sha>`, and the complete
`changedPaths`: the selected `CHANGELOG/YYYY.M.PATCH.md` is required, with only
`CHANGELOG.md` and `CHANGELOG/records/YYYY.M.PATCH.md` permitted alongside it.
Entry/record additions or modifications are permitted; index changes must be
modifications. Renames, deletions, other releases, and docs source edits require
fresh product qualification. Historical root-only receipts retain
`changelog-only-release-v1`. The split path should reuse the product matrix instead of
dispatching child lanes. Npm preflight and package/install acceptance still run
against the exact Release SHA and its new tarball bytes.

Current all-group FRV also owns read-only core and selected-plugin npm
source/build/qualification plus Docker preparation. Use its successful run as
`preflight_run_id`; the candidate
helper defaults to that run. Do not dispatch a second npm preflight unless
recovering historical separate evidence. Regular final qualification records
SDK reports for both `beta` and `latest`; review the acknowledgement for the
actual publication channel. Prepared descriptors live in `publicationArtifacts`
in the exact final manifest. Release Prepare adopts the manifest's plugin npm
descriptor and prepares only ClawHub; it never repacks plugin npm after FRV.
Product evidence reuse never substitutes Code-SHA
package or image bytes for the final Release SHA. For failed independent npm
qualification, use `pnpm frv continue --failed`:
failed npm jobs retry on their original run, successful preparation jobs
and diagnostic children carry forward, and the parent verifies the resulting
receipts. Failure alone is not a continuation rejection. Frozen workflows
execute their original receipt logic; a local controller upgrade does not
retrofit that logic, and final verification still owns the recovery result.

The SHA-pinned helper infers `beta` for matching beta release candidates and
`stable` for stable/correction versions, then passes the
C/Q/P run identity. Canonical beta `all` without soak
uses `npm-beta-v1`; `main` and non-beta targets do not qualify for that
policy. Run deferred native, performance, Telegram, broad live QA, and E2E as
postpublish confidence with the exact published package and
`run_release_soak=true` or explicit groups. Stable and full profiles force the
release soak. Native artifact publication still requires its own build,
signing, notarization, and promotion gates. Use a narrow `rerun_group` after
focused fixes; never widen automatically.
At seal time the parent records the SDK evidence digest from the qualified npm
receipt and resolves per-package npm plans against the registry. The manifest's
`publishInputs` supplies publisher/preflight defaults. SDK API changes still
need the operator's acknowledgement; sealed evidence does not grant authority.
Mutation owners recheck live publication authority, selectors, and immutable bytes.

### Publication requirements

Publish with `release_profile=from-validation` to consume the sealed profile.
Stable publication requires stable/full evidence, soak, and blocking performance.
Decide blocker or flake for every failed test. Rerun flakes on the same Release
SHA at most twice and file a fix-in-parallel issue/PR on `main`. A selected job
that remains red still blocks publication; never re-cut, change tooling, or
start a new FRV solely to clear a flake. Skipped, cancelled, missing, and unknown
coverage also blocks. No lane or soak waiver applies.

### Publish children

Use the maintainer [publication recovery guide](../release-openclaw-maintainer/references/publication-recovery.md)
for publication ordering and prepared/direct recovery.

- `pnpm release:stable <version>` ([orchestrated stable release](../release-openclaw-maintainer/references/regular-release.md#orchestrated-stable-release))
  dispatches the parent once, approves the parent's `npm-release` gate, prints
  child-approval commands only for older tooling without `npm-publish` and
  stale-child sweep commands when needed (it never mutates a child run).
  On any refusal it prints `Next:` with
  the exact recovery command.
- The parent's `npm-release` approval mints the attested
  `openclaw-release-approval-v1-<parent run>-<attempt>` receipt; bot-dispatched
  children verify it (`scripts/release-approval-receipt.mjs verify`) before
  their gates. The ClawHub OIDC child skips its `clawhub-plugin-release` gate
  on a verified receipt and instead waits for the parent's
  `openclaw-clawhub-parent-authorization-v2-*` receipt before publishing. npm
  children (`Plugin NPM Release`, `openclaw-npm-release.yml`) skip their
  `npm-release` approval job on the verified-receipt route and publish in
  `npm-publish`, with trusted publishers bound to that environment. Immediately
  before publication they wait for the parent attempt's receipt and require
  that attempt to remain `in_progress`. This is one human approval per release.
  `npm-publish` has no reviewers and admits only protected
  `release-publish/<sha12>-<n>` tags. Real manual/recovery npm dispatches must
  use such a tooling tag and still need their own `npm-release` approval job;
  the read-only OIDC preflight also uses `npm-publish` and requires that tag.
  Artifact-only preflights keep their existing refs and have no environment.
- Never approve a `plugin-clawhub-release.yml` child by hand. It is
  receipt-verified on the bot route and needs no approval. The
  `Artifact not found` line for `openclaw-clawhub-recovery-approval-<run>-1`
  is a non-fatal probe. A late human approval fails at `Revalidate trusted tooling identity`
  with `parent state completed/failure is not allowed by authorization route`
  once the parent has died (2026.9.6: runs 35930335388/35930341394). If core
  npm already published, recover ClawHub through explicit ClawHub recovery
  ([publication recovery](../release-openclaw-maintainer/references/publication-recovery.md#interrupted-preparation-and-publication));
  otherwise cancel the children and re-dispatch the parent. Bootstrap children
  (`plugin-clawhub-new.yml`) always wait on `clawhub-plugin-bootstrap`. Approve
  them after the secretless pack jobs finish
  ([first package](../release-openclaw-maintainer/references/first-package.md)).
- A v2 ClawHub child can stage most packages before one failure makes the
  awaited parent fail, preventing finalization of the staged siblings.
  Reconcile the original child's `*-publish-json` artifacts before any
  republish or parent resume. Use
  `pnpm release:clawhub-recovery -- --version <version> --reason '<parent failure>' --clawhub-source <isolated pinned ClawHub checkout> <package-publish.json>...`
  to print exact attempt recovery commands; see the publication recovery guide
  for the pinned source CLI and authorized execution. Public version 404s do
  not distinguish staged from missing, and attempt status needs publisher
  authentication. Parent receipts and live-authority revalidation remain
  required; recovery does not turn a failed parent into successful evidence.
- Before the first child dispatch the parent sweeps all selected publishers for a failed earlier parent's
  `waiting`/`queued` children of the same release (ClawHub and core by the
  `parent=<run>/<attempt>` run title; plugin npm by the release SHA, only
  while no other publish parent is live): it
  attempts gate rejection and cancellation, then waits up to 5 minutes per workflow.
  Rejection denied with 403 needs a reviewer; logs and the step summary include
  the reject/cancel commands. Unconfirmed cancellation warns. Core npm has an
  independent publish slot and rechecks its live parent, so it does not block;
  plugin npm and ClawHub retain target-serialized slots and refuse before any
  new dispatch if cancellation remains unconfirmed. Legacy unidentified ClawHub
  children or live publishers also retain the dispatch guard. A parent failure
  cancels its own waiting npm children. To clean up as a reviewer, list
  `workflow_dispatch` runs by `github-actions[bot]` created for this release,
  reject their gate, cancel:

  ```bash
  for s in waiting queued; do gh api "repos/openclaw/openclaw/actions/runs?status=$s&per_page=100" \
    --jq '.workflow_runs[] | select(.event=="workflow_dispatch" and .actor.login=="github-actions[bot]") | select(.name | test("plugin-clawhub|Plugin NPM Release|openclaw-npm-release")) | [.id,.name,.created_at] | @tsv'; done
  env_id=$(gh api repos/openclaw/openclaw/actions/runs/<child>/pending_deployments --jq '.[0].environment.id')
  gh api -X POST repos/openclaw/openclaw/actions/runs/<child>/pending_deployments \
    -f state=rejected -f comment="Reject stale release gate" -F "environment_ids[]=$env_id"
  gh run cancel <child> --repo openclaw/openclaw
  ```

- `gh run rerun --failed` on a plugin npm child fails its attempt-bound
  preflight artifact readback. The parent waits for the original child to
  settle and propagates its failure without dispatching a replacement.
  Diagnose and fix the failed owner before explicitly recovering publication;
  preserve successful immutable packages and evidence.

### Extended-stable validation

Use the same candidate-owned helper for `.33+` extended-stable validation:
C is the exact frozen branch tip, Q=C owns its complete qualification closure,
and independently trusted P admits and verifies it. The canonical
`extended-stable/YYYY.M.33` branch supplies context, not workflow authority.
Deliberately backport missing contracts before freezing C.

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

Only the helper creates the immutable `release-ci/<Q-prefix>-<timestamp>`
transport after admission. Never raw-dispatch, manually create its ref, or mint
a protected publication tag for Q. Reconcile an existing historical cross-revision
publish request under its original identity; never relabel it as candidate-owned.
A new explicit main/protected route is diagnostic, main-qualification, or
postpublish-confidence only and cannot replace this admitted Q=C publish proof.

Accept only a complete `rerun_group=all` run with a supported exact-target
manifest. Bind its workflow SHA separately from the candidate SHA; require the
manifest target, package versions, saved `run_attempt`, and final tag to identify
the same candidate. Reject narrow runs, untrusted tooling, mismatched targets,
and earlier-attempt evidence.

The all-group parent prepares core and selected plugin npm tarballs itself and
records their immutable descriptors in `publicationArtifacts`. Publication
must consume those exact artifacts and attempts. A standalone npm or plugin npm
preflight is diagnostic-only and cannot replace the manifest-bound evidence.

Product failures need an approved backport. Frozen-target tooling failures need
the smallest behavior-preserving repair. Provider, approval, runner, or log
races keep the candidate unchanged. Record repairs and superseded runs; any
branch change requires a new complete parent. Omit only an explicitly
unsupported frozen-target scenario, never a required behavior or package.

### Frozen-target test omissions

Use `plugin_prerelease_node_exclude_patterns_json` only for exact `src/plugins/`
test paths in the Plugin Prerelease Node lane. Use
`extension_test_exclude_patterns_json` for exact `extensions/` test paths in
Plugin Prerelease extension shards. Normal CI does not own that sweep. Both
default to `[]`; there is no implicit
Codex omission. Pass JSON arrays at initial dispatch, retain the justification
and owning fix, and report omitted coverage as not run.

Preflight must discover every requested path in the selected frozen-target
lane; nonexistent, out-of-lane, duplicate, basename, or glob inputs fail loudly.
Trusted tooling applies exact exclusions to inline Vitest leaves while
preserving candidate runtime preparation and restores original config bytes
after the shard command. Do not substitute CLI `--exclude` or a new target-side
environment variable: frozen inline projects may ignore them. Inputs remain in
the immutable request, coverage/reuse identity, and final manifest; changing
them requires a new request, never continuation.

## Watch

Watch children with the attempt-aware controller:

```bash
pnpm frv watch --run <full-release-run-id>
```

It resolves child run IDs from the parent's dispatch-job log lines
(`Dispatched <workflow>: <url> (attempt N)`), never from display titles, and
reports each parent and child attempt transition and each failed job once, with
runner labels. Transient GitHub 5xx or HTML
error bodies are retried on the next poll, never reported as job results.
State lives in `$TMPDIR/openclaw-frv/<repo>-<parent>-watch.json` (`--state`
overrides), so a restart after a harness or Monitor timeout does not re-report.
`--once` takes one snapshot, `--interval <seconds>` sets polling (default 60),
and `--json` prints NDJSON. It exits once the parent and every dispatched child
are terminal; restart it after a later rerun. Do not hand-roll bash or `gh`
watchers.

Watch candidate events derive the frozen SHA and context ref from the sealed
execution plan, not monitor scratch prose or the parent's tooling SHA. The tip
is read freshly; a changed tip labels that candidate superseded without stopping
observation or claiming qualification of the new tip. Missing evidence or a
SHA-only context stays unknown. Resume a missing or exited watcher with the same
command and state path: it performs reads only and suppresses already reported
terminal and candidate events. Never redispatch merely to restore a watcher.

For the parent's Release Decision, use the transition-only summary watcher:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id> --watch
```

Do not start this watcher when the SHA-pinned helper is still the foreground
owner. The helper reads the exact Release Decision artifact itself. On
`blocked_diagnostics_running`, it exits nonzero immediately, keeps the temporary
workflow ref, and leaves Diagnostic Drain collecting the remaining terminal evidence.
The watcher behaves the same way for separately dispatched parents: it reports
the Release Decision blocker once and exits while the drain continues.

For a one-shot snapshot:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id>
```

`release-ci-summary` accepts Full Release Validation parent runs only.
Diverged release-branch logs: `--first-parent` plus a bounded count.
Stop watchers before ending the turn or switching strategy.

For PR and child gates, read the exact workflow run, not the commit's check-run
list: `commits/<sha>/check-runs` keeps entries from superseded or cancelled
runs for the same head, so a stale `cancelled` or `failure` can mask a newer
success. Resolve the newest `CI` run for the head (`actions/runs?head_sha=<sha>`)
and read `openclaw/ci-gate` from that run's jobs before retrying or reporting.

Interpret state precisely:

- `qualifying`: no decisive blocker yet; selected children are still active.
- `blocked_diagnostics_running`: publication is blocked; Diagnostic Drain is
  still collecting independent failures. Diagnose now and use `frv rerun` or
  `continue --failed` when the failed child is terminal; final parent resealing
  still waits for complete evidence.
- `passed`: all required policy and exact-child evidence passed.
- `blocked_complete`: publication is blocked and all selected diagnostics are
  terminal.
- `orchestration_error`: GitHub API or collector failure prevented a verdict.
  This does not mean the wrong source was used. Recover the collector against the same
  exact children; never redispatch tests to repair collection.
- `cancelled_with_children`: the collector was cancelled while exact children
  remained active.

Read every selected lane's actual conclusion. `passed` requires every selected
validation lane to succeed; omitted coverage is not run, never passed.

The `full-release-diagnostics-<run-id>-<attempt>` artifact is the terminal
failure and timing manifest. Use it after an early blocker instead of
restarting `all` merely to discover what the still-running children found.
The stable `full-release-execution-plan-<run-id>` artifact is the identity
source within each collector attempt; retry attempts restore its immutable
run-ID-cached bytes first.

## Failure Triage

1. Confirm parent SHA and child run IDs.
2. List failed jobs with `pnpm frv watch --run <parent> --once`; it prints each
   failed job with its attempt, runner labels, and URL.
3. Fetch one failed job log. If rate-limited, note reset time and avoid more REST calls.
4. For secret-looking failures, validate a real completion from the same secret source before editing code. A successful model-list request is insufficient.
   Claude CLI subscription credentials are a separate native auth path; prove
   them in a clean-home CLI probe, never as a substitute for a required
   Anthropic API-key lane.
5. For live-cache failures, inspect whether it is missing/invalid key, empty text, provider refusal, timeout, or baseline miss. Do not weaken release gates without clear provider evidence.
6. Decide blocker or flake for each failed test before editing. Track a fix for
   flakes on `main`; every selected job must still pass before publication.
   Classify blockers further:
   - confirmed product/code failure: fix the release branch, freeze a new Code
     SHA, and invalidate product evidence
   - qualification harness/contract defect: repair the candidate closure and
     freeze new C/Q; preserve the superseded evidence and its invalidation reason
   - P-only admission/verifier/publisher defect: preserve C/Q and original
     artifacts, repair independent trusted P, and recover the affected surface
   - infrastructure/credential failure: keep C/Q/P, repair the external
     prerequisite, and retry only the failed surface
   - wrapper/monitor failure: keep the child and candidate identities; record
     the wrapper result separately from the child result
   - changelog/release-note failure: change only the selected release entry and
     permitted record/index paths under `split-changelog-release-v1`, keep Code SHA
     evidence, and repeat Release SHA proof
   - publish child/registry selector failure: keep Release SHA and resume the
     failed child; never rebuild an immutable version that already published
   - parent failed after core npm published (for example a stale `beta`
     dist-tag failing the completion verify): retain the successful original
     npm run and qualified bytes, repair the selector, and reconcile the exact
     failed parent's children before resuming the selected publication route.
     Direct finalization normally waits for npm and Docker verification; the
     prepared button also verifies ClawHub downloads. Do not manually un-draft
     a release to bypass those gates. Follow
     [publication recovery](../release-openclaw-maintainer/references/publication-recovery.md#published-version-failed-parent)
     for direct resume or a new prepared button run.
   - child stuck `waiting`, ClawHub `Artifact not found`, or parent failing
     `ClawHub dispatch blocked by waiting run`: see [Publish children](#publish-children)
     Only product or qualification-harness defects change C/Q. After one diagnosis/fix/narrow
     retry, reassess instead of starting another all-group cycle.
7. Runner routing: FRV-dispatched CI and Plugin Prerelease children always run
   hosted `ubuntu-24.04` (or the release runner group). Other release lanes
   follow `OPENCLAW_CI_RUNNER_BACKEND`, so a flip to `github` during a Blacksmith
   outage moves them to hosted runners, except the QA Lab runtime-pair lane: it
   fails on hosted runners and stays pinned to Blacksmith, queuing through an
   outage. Release Checks prints a `Release runner routing` notice while the
   flip is active. Codex extension tests run as file-bounded Plugin Prerelease
   jobs because one hosted Codex batch took 36-60 minutes.
8. If a required PR CI run is capacity-stalled with queued jobs and no active
   jobs, do not cancel unrelated work or accept a generic manual dispatch.
   First verify the PR head carries the current fallback schema:
   `gh api 'repos/openclaw/openclaw/contents/.github/workflows/ci.yml?ref=<pr-head-branch>'
--jq .content | base64 --decode | rg -q 'pull_request_number:'`. If absent,
   refresh the PR head from `main` and use the new head SHA; let normal CI run
   before considering another fallback.
   From the PR head branch, dispatch the explicit exact-SHA fallback:
   `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f
target_ref=<full-pr-sha> -f pull_request_number=<pr-number> -f
include_android=true -f release_gate=true`.
   It runs on GitHub-hosted runners and is accepted only when its run title is
   `CI release gate <full-pr-sha>`. Record the stalled Blacksmith run and the
   fallback run in release evidence.
   If `Blacksmith Build Artifacts Testbox` is the only remaining required gate
   and remains queued without a runner, that completed exact fallback may cover
   it because CI's `build-artifacts` job already builds, packages, and smoke
   tests the artifacts. Do not use this coverage after the artifact workflow
   starts or completes non-successfully.

## Evidence

Record:

- release lifecycle ledger: Code SHA and Release SHA for regular releases;
  canonical branch, exact SHA, and immutable tag for extended-stable; C/Q/P,
  original admission descriptor, and retained request for either track
- evidence-reuse policy, coverage policy, and complete changed-path set
- active full parent run URL, attempt, workflow SHA, and any superseded parent
  with the exact replacement reason
- selected child run IDs and conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance; record deferred confidence as not run
- exact core and plugin npm publication artifact descriptors from the terminal manifest
- all selected lane conclusions, including Linux/Windows/macOS cross-OS
- performance comparison result versus earlier releases when available
- targeted local proof commands
- frozen-target compatibility repairs or omitted inapplicable scenarios, with
  their source PRs and invariant
- hosted proof and its deployment prerequisites separately from local contract
  tests; mocks do not prove Actions admission, OIDC, environment access, or publication
- known gaps or unrelated failures

For lessons and recovery patterns, read `references/release-ci-notes.md`.
