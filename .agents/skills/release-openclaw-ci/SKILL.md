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
- Record every active validation run as the immutable tuple **Validation SHA +
  Tooling SHA + rerun group**. Validation SHA maps to the Code SHA for product validation or
  the Release SHA for changelog-only validation; it is not a third release
  identity. A branch or temporary ref is context and transport.
- The candidate helper accepts an absent release tag or an existing lightweight
  or annotated tag resolving to the exact candidate SHA. A conflicting tag or
  failed remote lookup stops validation; never move a tag to recover.
- Freeze the candidate SHA/ref and Tooling SHA/ref once. Main lineage authorizes
  the initial Tooling SHA selection; it does not authorize replacing that
  tooling after `main` advances.
- Apply a release firebreak after the Code SHA is frozen. Admit only confirmed
  product defects, package/provenance defects in the bytes to publish, security
  defects, or failures that make publication impossible. Queue other findings
  for postpublish confidence or the next beta.
- Frozen CI children use the pinned Tooling SHA's Node shard planner and measured
  costs, while discovering and executing tests from the candidate checkout.
  Hosted full-release plans split measured rows above 12 minutes; preserve file
  coverage, worker limits, and complete timing generations. An indivisible
  over-budget owner must be split rather than increasing the release budget.
  After the child completes, closeout runs `scripts/ci-shard-timings-refresh.mts`
  for that exact run and commits generated costs; do not hand-edit measurements.
- Use trusted `main` workflow revisions as immutable dispatch sources. Do not
  adopt newer main code, repair unrelated main CI, wait for broad main health,
  or expand a release fix because the workflow source lives on `main`.
- Once publication binds the Tooling SHA to an exact protected lightweight
  `release-publish/<12sha>-<provenance-run>` tag, that live tag-to-SHA mapping
  remains authoritative when `main` advances. The suffix records tag-creation
  provenance; it is not the current parent run id. The regular release helpers
  mint or reuse that tag from `--workflow-sha <tooling-sha>`.
- Touch `main` only for an operator-requested change or the smallest critical
  main-owned blocker that prevents this release and cannot be handled from the
  release branch. If the required main landing policy is blocked by unrelated
  main failures, report that blocker and keep independent release work moving
  instead of healing broader main.
- Land tooling-only fixes on `main` with the `release-fast-lane` label added
  before the push (RELEASING.md "Release tooling fast lane"): `openclaw/ci-gate`
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
- Validate provider secrets before dispatching expensive full release matrices.
- Check the nightly parent for the Code SHA before dispatching a fresh main validation; it seals per-child receipts that exact-target dispatches adopt when inputs match.
- Two publication modes (RELEASING.md "Publication modes"). Strict default: a
  stable tag needs stable/full evidence with soak and blocking performance and no
  failed non-proof lane. Operator fast path: `stable_soak_waiver` /
  `lane_waiver` (input or repository variable, reason prefixed with the target
  version) are the only way past that; waivers are recorded in the manifest,
  decision, receipt, release evidence, and closeout, and reported as warnings.
  Every lane runs once on every OS; first failures are recorded, never retried.
  Required in every mode: artifact children, install-smoke, survivors,
  first-hop compat, pack/npm qualification, package integrity, target
  resolution, Linux Gateway cross-OS lanes, and their aggregators.
- Native macOS, Windows, Linux, and Android publication is independent of
  npm/ClawHub, GitHub finalization, and main closeout. Each platform retains
  its own signing, qualification, artifact, and updater requirements; report
  pending platforms accurately and repair native-only failures in parallel.
- Release validation does not pause CI or supporting workflows. The legacy
  `OPENCLAW_RELEASE_PRIORITY_RUN` variable is ignored by current workflow
  admission. Do not use `pnpm frv prioritize --run` for routine validation;
  it still cancels queued runs. Use `pnpm frv prioritize --restore <record>`
  to recover runs deferred by older workflow revisions and clear their variable.
  Keep the required publication proofs and soak gates intact.
- Do not set GitHub secrets from unvalidated 1Password candidates. If a candidate returns 401/403, leave the existing secret alone and report the exact missing provider.
- Use `$one-password` for secret reads/writes: one persistent tmux session, targeted items only, no secret output.
- Watch one parent run plus compact child summaries. Avoid broad `gh run view` polling loops; REST quota is easy to burn.
- Fetch logs only for failed or currently-blocking jobs. If quota is low, stop polling and wait for reset.
- Treat live-provider flakes separately from code failures: prove key validity, provider HTTP status, retry evidence, and exact failing lane before editing code.
- A model-list response proves authentication, not billing or inference
  entitlement. Mandatory live providers must pass a real completion probe
  before release dispatch. Fix the credential first; do not add an alternate
  auth path merely to bypass a failed release credential.
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
  candidate and Tooling SHAs frozen, supersede that parent, and start a fresh
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
  workflow path, ref, Tooling SHA, dispatch title, event, target, candidate, and
  validation inputs remain exact. Newer child attempts replace matching jobs;
  jobs absent from a newer attempt carry forward. A duplicate job identity,
  missing attempt, regressed attempt, or changed tuple fails closed. `frv status`
  and `continue` allow up to 60 seconds of read-only reconciliation when GitHub
  temporarily returns duplicate jobs in the newest retry attempt. The run tuple
  and attempt stay pinned; persistent duplicates and older-attempt conflicts
  remain errors.
- Use `pnpm frv status|rerun --job|continue --failed|verify` for attempt-aware recovery.
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
- Use one release operator, one transition-only watcher, and at most one
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
- Reused Testboxes are provenance-gated after their first successful run.
  Source-only edits may reuse the lease; base, dependency, wrapper, or Testbox
  workflow drift requires a fresh lease. Do not set
  `OPENCLAW_TESTBOX_ALLOW_STALE=1` for release evidence.
- For a committed release candidate, warm the box with
  `blacksmith testbox warmup ... --ref <candidate-branch-or-sha>`. Do not rely
  on source sync to overlay committed branch changes onto the workflow's
  default ref.

## Run identity and retry budget

Record Validation SHA, Tooling SHA/ref, target context ref, parent run id,
attempt, and phase before watching or recovering Full Release Validation. Keep
Code SHA and Release SHA as lifecycle roles in the ledger; they may name the
same commit. Record the
immutable Release Publish parent receipt separately from tag provenance.

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
  - `stable-publish`: `release_profile=stable` with soak and performance by
    default (strict); beta-profile evidence publishes a stable only with an
    approved `stable_soak_waiver` (operator fast path)
- An `all` run without soak for an actual beta package on its matching canonical
  release branch or beta tag records `coveragePolicy=npm-beta-v1`. It keeps
  Linux/macOS/Windows Node, Control UI, plugin, package, install/update,
  Linux cross-OS, QA parity, runtime-pair/restart, and tool coverage. Only the
  required install/update/package proofs gate npm/ClawHub; other tests are advisory. Native app
  CI, performance, and published-package Telegram are deferred to confidence.
  Beta `all` without soak also defers Package Acceptance Telegram, including
  beta-profile checks of `main` or alpha. Record deferred checks as not run,
  never passed. Stable/full, soak, and focused groups retain their coverage;
  selected children still require terminal evidence. An absent coverage policy
  retains historical full behavior.
- Keep at most one active parent for the same Validation SHA + Tooling SHA + rerun
  group + release profile + effective soak coverage. Stable/full always include
  soak. Distinct coverage profiles can run independently; concurrency does not
  cancel an older exact child automatically.
- Parent cancellation or timeout leaves adopted identity-checked children
  running. The operator must cancel an exact child explicitly when it is no
  longer useful. Do not infer a child identity from branch, title prefix, or
  latest-run order.
- Recover one failed surface with one diagnosis, one fix when needed, and one
  narrow retry. Then reassess the release decision. Do not automatically
  dispatch `rerun_group=all`.
- Never automatically rerun a failed or timed out test job. New dispatches reject
  `known_flaky_jobs_json`; diagnose the original failure and fix its owner before
  explicit operator recovery.
- For a supported parent, `pnpm frv rerun --run <parent-run-id> --job
"<child-key>:<exact job name>"` reruns one executed terminal job using its accepted
  Actions job ID. Get the child key and exact name from `frv status --json`.
  GitHub also reruns dependent jobs. The controller waits only for that child
  before sending the request; it does not retry unrelated failures.
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
a failed locale job is recorded as advisory for npm/ClawHub. PR-side checks and
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
node .agents/skills/release-openclaw-ci/scripts/verify-provider-secrets.mjs --required openai,anthropic,fireworks
gh api rate_limit --jq '.resources.core'
git status --short --branch
git rev-parse HEAD
```

1Password service-account values are the first source for release provider
preflight. Inject those exact targeted keys first, then run the verifier; use
ambient env only when it was already intentionally injected for this release.
The script prints only provider status and HTTP class, never tokens.
The Anthropic check performs a tiny message completion so exhausted or
non-billable credentials fail before the expensive release matrix.

### Before publication

For regular beta/stable protected publication, after evidence validation run
`pnpm release:publish-preflight` with the intended tag, exact Full Release
Validation run and attempt, npm dist-tag, plugin scope, approved soak waiver when
applicable, and protected publication tooling ref. `pnpm release:candidate`
invokes this check with its downloaded manifests; do not redownload them or
replace the selected attempt. Use the report's exact dispatch command for the
chosen publication route only after resolving every `FAIL` and owner-action
`WARN`. Alpha uses its matching Tideclaw branch; extended-stable retains its
separate owner workflows and is not admitted by this preflight.

Check the report before retrying a failed publication: preserve the verified
`openclaw_npm_resume_run_id` for already-published core bytes, inspect matching
draft/published release state, and identify exact orphaned plugin/ClawHub children
before cancellation. Preflight is read-only and does not authorize publication,
cancel children, or prove a repository secret from local credentials. Bootstrap
candidates need a read-only `npm whoami` probe using the repository's actual
`NPM_TOKEN`; follow the secret-isolated step in
[Release policy](https://docs.openclaw.ai/reference/RELEASING#probe-the-bootstrap-token)
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
`reuse_evidence=true`, dispatch checks at most 30 recent runs and five receipts
per role within two minutes. It can adopt green children from failed, cancelled,
or active parents for the exact target, inputs/defaults, and candidate descriptor
bytes; unmatched roles dispatch fresh work. The current-parent adoption witness
and immutable execution plan bind each selection. Collectors and final verification
recheck the live child attempt and conclusion, main ancestry, exact inputs,
artifact identity/digest/expiry, and successful trusted seal/upload steps. A newer
attempt invalidates reuse; do not rerun an adopted child to repair a collector.
Current-parent source/publication admission and the separate successful-parent
changelog reuse path remain unchanged. Artifact producers retain their existing
sealed receipts.

An early standalone product-performance run is optional beta confidence. If
useful, start it against the frozen Code SHA in parallel with release work:

```bash
# Advisory for beta; stable publication needs blocking performance evidence unless waived.
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
  Performance results are advisory for beta, stable, and full profiles; no
  performance waiver is needed for npm/ClawHub publication or main closeout.
- Closeout replay reuses sealed waiver text without retyping; only new operator
  text must carry the version prefix.
- `npm-beta-v1` defers the performance child. Every selected child still needs
  terminal evidence and must prove artifact-only publication.

Prefer an immutable trusted-main workflow revision, target the exact Code SHA:

- Keep trusted-workflow checks compatible with frozen release targets. If
  `main` adds a target-owned guard script or package command after the release
  branch cut, make the trusted workflow skip only when that target surface is
  absent. Repair the smallest trusted-workflow compatibility issue only when it
  blocks the release, then rerun validation. Do not port an unrelated runtime
  refactor, heal other main failures, or mutate the release candidate just to
  satisfy a newer `main`-only check.

```bash
TOOLING_SHA="<exact-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
node scripts/full-release-validation-at-sha.mjs \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

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
matching beta prerelease. Alpha remains on the Tideclaw path with a matching
alpha branch and exact alpha tag. Extended-stable branches and all tags require
an exact package-version match.
Always pass the previously recorded full Tooling SHA for release-branch runs.
Never replace it with a fresh `main` lookup. The Tooling SHA must declare the
current release-isolation contract; older workflow revisions fail closed.

For immutable workflow proof on a moving `main`, use
`pnpm ci:full-release --sha <code-sha> --target-ref
release/YYYY.M.PATCH --workflow-sha <tooling-sha> -f validation_purpose=publish
-f publication_selection_json="$PUBLICATION_SELECTION"`. Its canonical `release-ci/*` ref keeps evidence reuse
enabled after proving the workflow commit is still on trusted `main` lineage.
Pass `-f reuse_evidence=false` only when the operator intentionally needs a
fresh full run.

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

Current all-group FRV also owns read-only npm source/build/qualification and
Docker preparation. Use its successful run as `preflight_run_id`; the candidate
helper defaults to that run. Do not dispatch a second npm preflight unless
recovering historical separate evidence. Regular final qualification records
SDK reports for both `beta` and `latest`; review the acknowledgement for the
actual publication channel. Prepared descriptors live in `publicationArtifacts` in
the exact final manifest. Product evidence reuse never substitutes Code-SHA
package or image bytes for the final Release SHA. For failed independent npm qualification, use `pnpm frv continue --failed`:
failed npm jobs retry on their original run, successful preparation jobs
and diagnostic children carry forward, and the parent verifies the resulting
receipts. Failure alone is not a continuation rejection. Frozen workflows
execute their original receipt logic; a local controller upgrade does not
retrofit that logic, and final verification still owns the recovery result.

The SHA-pinned helper infers `beta` for matching beta release candidates and
exact alpha tags, and `stable` for stable/correction versions, then passes the
Validation SHA + Tooling SHA run identity. Canonical beta `all` without soak
uses `npm-beta-v1`; `main`, alpha, and non-beta targets do not qualify for that
policy. Run deferred native, performance, Telegram, broad live QA, and E2E as
postpublish confidence with the exact published package and
`run_release_soak=true` or explicit groups. Stable and full profiles force the
release soak. Native artifact publication still requires its own build,
signing, notarization, and promotion gates. Use a narrow `rerun_group` after
focused fixes; never widen automatically.
At seal time the parent records the SDK evidence digest from the exact qualified
npm receipt, resolves per-package npm plans against the registry, and captures
`vars.OPENCLAW_RELEASE_STABLE_SOAK_WAIVER` when configured. The manifest's
`publishInputs` supplies publisher/preflight defaults; explicit SDK and soak
inputs override them. The sealed digest is evidence only: SDK API changes still
need an operator-supplied `plugin_sdk_api_acknowledgement` at publication, and
the sealed waiver applies only while the repository variable still holds it. Mutation owners still recheck live publication authority,
registry selectors, and immutable bytes. Clear temporary waiver text at closeout.

Publish with `openclaw-release-publish.yml` using `release_profile=from-validation`
unless a maintainer intentionally wants to cross-check a specific profile; the
publish workflow reads the effective profile from the full-validation manifest.
Stable publication requires soak or an approved reason from sealed `publishInputs`
or the explicit `stable_soak_waiver` override; the publisher records that reason in release evidence
without changing validation coverage or other publication gates.
For npm/ClawHub, artifact children, install smoke, both survivor lanes, all
`update-first-hop-compat*` lanes, pack budget/npm qualification, and target
resolution remain required. Verify aggregators follow their required inputs.
Normal CI, plugin prerelease, cross-OS, performance, and QA test failures are
advisory by default and remain recorded evidence; no lane waiver is needed.
Provenance and complete evidence checks still apply. The explicit first-hop
escape hatch uses `OPENCLAW_FRV_LANE_WAIVER="<target version> <reason>"` only
when survivor lanes in the same child passed, requires `lane_waiver` at publish,
and must be cleared after the release.

### Publish children

- `pnpm release:stable <version>` (RELEASING.md "Orchestrated stable release")
  dispatches the parent once, approves the parent's `npm-release` gate, prints
  the child-approval and stale-child sweep commands below instead of running
  them (it never mutates a child run), and on any refusal prints `Next:` with
  the exact recovery command.
- The parent's `npm-release` approval mints the attested
  `openclaw-release-approval-v1-<parent run>-<attempt>` receipt; bot-dispatched
  children verify it (`scripts/release-approval-receipt.mjs verify`) before
  their gates. The ClawHub OIDC child skips its `clawhub-plugin-release` gate
  on a verified receipt and instead waits for the parent's
  `openclaw-clawhub-parent-authorization-v2-*` receipt before publishing. npm
  children (`Plugin NPM Release`, `openclaw-npm-release.yml`) keep
  `npm-release` (npm trusted publishers are bound to it, `npm trust list
openclaw`) and the workflow token cannot approve it (`canApprove=false`), so
  an unapproved npm child sits `waiting` silently. Watch every child and
  approve npm children only (environment id `13010111854`):
  ```bash
  gh api repos/openclaw/openclaw/actions/runs/<child>/pending_deployments
  gh api -X POST repos/openclaw/openclaw/actions/runs/<child>/pending_deployments \
    -f state=approved -f comment="<reason>" -F 'environment_ids[]=13010111854'
  ```
- Never approve ClawHub children (`plugin-clawhub-release.yml`,
  `plugin-clawhub-new.yml`) by hand. `plugin-clawhub-release.yml` needs no
  approval on the bot route (receipt-verified); the `Artifact not found` line
  for `openclaw-clawhub-recovery-approval-<run>-1` is a non-fatal probe, and a
  late human approval fails at `Revalidate trusted tooling identity` with
  `parent state completed/failure is not allowed by authorization route`
  once the parent has died (2026.9.6: runs 35930335388/35930341394). If the
  parent died, cancel the children and re-dispatch the parent.
- Before every child dispatch the parent sweeps a failed earlier parent's
  `waiting`/`queued` children of the same release (ClawHub and core by the
  `parent=<run>/<attempt>` run title; plugin npm by the release SHA, only
  while no other publish parent is live): it
  rejects their gate, cancels, and waits up to 5 minutes for GitHub to report
  them cancelled (a waiting run takes ~2 minutes). A parent failure also
  cancels its own waiting npm children. Only legacy children without a parent
  identity in their title, or a live publisher job, still block with
  `ClawHub dispatch blocked by waiting run`; sweep those by hand. List
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
- Core child `Verify full release validation target` failing with
  `pass lane_waiver=<reason> to acknowledge it`: the tooling tag predates
  #156816 (waiver forwarded to children). Cut a new tooling tag from a `main`
  that includes it; the candidate and validation evidence stay valid.

### Extended-stable validation

Use one remote-only procedure for `.33+` extended-stable validation. Keep these
four identities separate:

- **Validation SHA:** exact 40-character candidate commit to validate.
- **Tooling SHA:** exact trusted-main commit whose workflows and helpers run.
- **Context ref:** canonical `extended-stable/YYYY.M.33` branch containing the
  candidate.
- **Workflow transport ref:** immutable
  `release-ci/<tooling-sha-prefix>-<unique-id>` branch at the Tooling SHA.

GitHub workflow dispatch `--ref` accepts a branch or tag name, not a raw commit
SHA. Never raw-dispatch this validation or hand-assemble its identity inputs.
Use the checked helper exclusively:

```bash
VALIDATION_SHA="<exact-candidate-sha>"
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
CONTEXT_REF="extended-stable/YYYY.M.33"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref "$CONTEXT_REF" \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json='{"route":"extended-stable","npmDistTag":"extended-stable","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}' \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f fail_fast=false \
  -f rerun_group=all \
  -f reuse_evidence=false \
  -f dispatch_release_evidence=false
```

The helper verifies both SHAs, creates the transport ref with the equivalent of
the following GitHub refs operation, and dispatches from that branch:

```bash
gh api --method POST repos/openclaw/openclaw/git/refs \
  -f ref="refs/heads/release-ci/${TOOLING_SHA:0:12}-<unique-id>" \
  -f sha="$TOOLING_SHA"
```

Do not run that operation separately. The helper also supplies
`ref=$VALIDATION_SHA`, `expected_sha=$VALIDATION_SHA`,
`target_context_ref=$CONTEXT_REF`, and this exact trusted identity:

```text
{"fullRef":"refs/heads/main","ref":"main","sha":"<tooling-sha>"}
```

Outside this extended-stable procedure, a direct canonical-branch dispatch is
valid only when that branch's own head is both the Validation SHA and the
trusted workflow implementation to execute. It cannot use a different
trusted-main Tooling SHA. Current extended-stable validation requires distinct
trusted-main tooling, so it must use the immutable `release-ci/*` transport
above. Direct canonical-branch and mutable-`main` dispatches are not valid
alternatives for this procedure.

Accept only a complete `rerun_group=all` run with a supported exact-target
manifest. Bind its workflow SHA separately from the candidate SHA; require the
manifest target, package versions, saved `run_attempt`, and final tag to identify
the same candidate. Reject narrow runs, untrusted tooling, mismatched targets,
and earlier-attempt evidence.

Run the npm preflight separately from trusted `main`. Here `tag` is the exact
candidate SHA; it is an npm-preflight input, not the workflow transport ref:

```bash
gh workflow run openclaw-npm-release.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f tag="$VALIDATION_SHA" \
  -f preflight_only=true \
  -f npm_dist_tag=extended-stable \
  -f release_candidate_branch="$CONTEXT_REF"
```

This standalone run is a supplemental validation-only preflight. Do not pass
its run ID as publication `preflight_run_id`: a `main` workflow head does not
have the canonical candidate branch/SHA identity required by that publication
input. Publication continues to use the Full Release Validation run's
manifest-bound integrated npm artifact and exact run attempt.

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

Use the transition-only summary watcher instead of repeated raw polling:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id> --watch
```

Do not start this watcher when the SHA-pinned helper is still the foreground
owner. The helper reads the exact Release Decision artifact itself. On
`blocked_diagnostics_running`, it exits nonzero immediately, keeps the temporary
refs, and leaves Diagnostic Drain collecting the remaining terminal evidence.
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
  This is not a provenance mismatch. Recover the collector against the same
  exact children; never redispatch tests to repair collection.
- `cancelled_with_children`: the collector was cancelled while exact children
  remained active.

Read **advisory** entries separately from Release Decision. Non-proof lanes
retain actual conclusions in the manifest and summary; `passed` does not mean
they passed, and a stable publishes with failed ones only under `lane_waiver`.
Selected lanes still need terminal evidence, and filtered-out lanes are not
run, never passed.

The `full-release-diagnostics-<run-id>-<attempt>` artifact is the terminal
failure and timing manifest. Use it after an early blocker instead of
restarting `all` merely to discover what the still-running children found.
The stable `full-release-execution-plan-<run-id>` artifact is the identity
source within each collector attempt; retry attempts restore its immutable
run-ID-cached bytes first.

## Failure Triage

1. Confirm parent SHA and child run IDs.
2. List failed jobs only:
   ```bash
   gh run view <child-run-id> --repo openclaw/openclaw --json jobs \
     --jq '.jobs[] | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | [.databaseId,.name,.conclusion,.url] | @tsv'
   ```
3. Fetch one failed job log. If rate-limited, note reset time and avoid more REST calls.
4. For secret-looking failures, validate a real completion from the same secret source before editing code. A successful model-list request is insufficient.
   Claude CLI subscription credentials are a separate native auth path; prove
   them in a clean-home CLI probe, never as a substitute for a required
   Anthropic API-key lane.
5. For live-cache failures, inspect whether it is missing/invalid key, empty text, provider refusal, timeout, or baseline miss. Do not weaken release gates without clear provider evidence.
6. Classify before editing:
   - confirmed product/code failure: fix the release branch, freeze a new Code
     SHA, and invalidate product evidence
   - harness/tooling/provenance failure: keep the Code SHA, fix the smallest
     owning surface, and retry only the failed surface with the required Tooling
     SHA
   - infrastructure/credential failure: keep both SHAs, repair the external
     prerequisite, and retry only the failed surface
   - wrapper/monitor failure: keep the child and candidate identities; record
     the wrapper result separately from the child result
   - changelog/release-note failure: change only the selected release entry and
     permitted record/index paths under `split-changelog-release-v1`, keep Code SHA
     evidence, and repeat Release SHA proof
   - publish child/registry selector failure: keep Release SHA and resume the
     failed child; never rebuild an immutable version that already published
   - parent failed after core npm published (for example a stale `beta`
     dist-tag failing the completion verify): flip the GitHub release public
     immediately with
     `gh release edit v<version> --repo openclaw/openclaw --draft=false --latest`;
     never leave it drafted waiting for Docker, ClawHub, apps, or the resume.
     Then run the beta-to-stable dist-tag sync, sweep stale children, and
     dispatch a new parent with the same inputs: it recognizes published bytes
     and only runs ClawHub, GitHub release evidence, and Docker
   - child stuck `waiting`, ClawHub `Artifact not found`, or parent failing
     `ClawHub dispatch blocked by waiting run`: see [Publish children](#publish-children)
     Only the first class changes the Code SHA. After one diagnosis/fix/narrow
     retry, reassess instead of starting another all-group cycle.
7. If a required PR CI run is capacity-stalled with queued jobs and no active
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

- release lifecycle ledger: Code SHA, Release SHA, and Tooling SHA for regular
  releases; canonical branch, exact SHA, and immutable tag for extended-stable
- evidence-reuse policy, coverage policy, and complete changed-path set
- active full parent run URL, attempt, workflow SHA, and any superseded parent
  with the exact replacement reason
- selected child run IDs and conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance; record deferred confidence as not run
- all advisory lane classifications and actual conclusions, including cross-OS
- performance comparison result versus earlier releases when available
- targeted local proof commands
- provider-secret preflight result
- frozen-target compatibility repairs or omitted inapplicable scenarios, with
  their source PRs and invariant
- known gaps or unrelated failures

For lessons and recovery patterns, read `references/release-ci-notes.md`.
