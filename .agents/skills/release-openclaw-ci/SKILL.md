---
name: release-openclaw-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use this with `$release-openclaw-maintainer` and `$openclaw-testing` when a release candidate needs full validation, install/update proof, live provider checks, or CI recovery.

## Guardrails

- No version bump, tag, npm publish, GitHub release, or release promotion without explicit operator approval.
- Validate provider secrets before dispatching expensive full release matrices.
- Do not set GitHub secrets from unvalidated 1Password candidates. If a candidate returns 401/403, leave the existing secret alone and report the exact missing provider.
- Use `$one-password` for secret reads/writes: one persistent tmux session, targeted items only, no secret output.
- Watch one parent run plus compact child summaries. Avoid broad `gh run view` polling loops; REST quota is easy to burn.
- Fetch logs only for failed or currently-blocking jobs. If quota is low, stop polling and wait for reset.
- Treat live-provider flakes separately from code failures: prove key validity, provider HTTP status, retry evidence, and exact failing lane before editing code.
- A model-list response proves authentication, not billing or inference
  entitlement. Mandatory live providers must pass a real completion probe
  before release dispatch. Fix the credential first; do not add an alternate
  auth path merely to bypass a failed release credential.
- Full Release Validation parent monitors fail fast: once a required child job
  fails, the parent cancels the remaining child matrix and prints the failed
  job summary. Inspect that first red job instead of waiting for unrelated
  matrix tails.
- For a beta whose delta matches a checked-in release delta policy, use the
  trusted-main `Release Delta Evidence` workflow instead of restarting
  unaffected product lanes. The terminal manifest binds one direct
  source-to-target hop, the exact changed paths and artifact hashes, the
  terminal target parent SHA, and every selected run/job/artifact identity.
  Reuse never chains. Cancelled aggregate runs are acceptable only when the
  policy names exact successful leaf jobs; failed or cancelled leaves are
  rejected.
  Fresh target package proof and every path-impacted gate remain required.
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
- For a committed release candidate, warm the box with
  `blacksmith testbox warmup ... --ref <candidate-branch-or-sha>`. Do not rely
  on source sync to overlay committed branch changes onto the workflow's
  default ref.

## Preflight

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

## Delta Evidence

Use delta evidence only with a reviewed policy committed directly under
`.github/release-delta-policies/` on trusted `main`. The policy owns the
release ref, version, tag, changelog base, source and baseline SHAs, allowed
paths, metadata exclusions, evidence inputs, impact patterns, and any
exact-target producer roles. Do not add those release-specific values to the
generic workflow.

Dispatch attempt 1 from `main`:

```bash
ghx workflow run release-delta-evidence.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_sha=<full-release-sha> \
  -f policy_path=.github/release-delta-policies/<policy>.json \
  -f evidence_runs_json="$(jq -c . evidence-runs.json)"
```

Before accepting the result:

1. Confirm the source is an ancestor of the target, the range is linear, the
   terminal commit is `CHANGELOG.md`-only, and the commit path union equals the
   endpoint diff.
2. Confirm every changed non-metadata path matches fresh evidence and matches
   no reused role. Producer roles schedule only their fixed exact-target jobs;
   undeclared producer jobs must be skipped.
3. Confirm each reused role has no impacted path and resolves one successful
   native run and exact job, with the configured run, log, or artifact binding
   the source SHA. A cancelled aggregate may contribute successful leaves, but
   a failed or cancelled leaf cannot.
4. Check the manifest's policy blob/hash, source/terminal-parent/target SHAs,
   path audit, runtime-tree hashes, package hashes, ClawHub roster, role
   gates and conclusions, producer evidence, cancelled-aggregate dispositions,
   and reuse rationale.
5. Keep the exact-target npm preflight authoritative. Canonical package
   equivalence is required when selected by policy; otherwise require the
   policy's fresh exact-target package proof. The source npm, target npm, and
   Telegram package roles must be three distinct single-run inputs with their
   fixed workflow, job, artifact, report, and binding contracts.

Never use a prior delta manifest as an evidence input. Publish consumers
resolve the policy from the authenticated producer artifact, recompute the
delta, trust bundle, ClawHub roster, changelog, and release notes, verify the
promotable npm bytes against the recorded exact-target hashes, and recheck the
live release branch, verified signature, and tag peel immediately before
mutation.

## Dispatch

Start product performance evidence as early as the release SHA exists, in
parallel with other release work:

```bash
gh workflow run openclaw-performance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_ref=<release-sha> \
  -f profile=release \
  -f repeat=3 \
  -f deep_profile=false \
  -f live_openai_candidate=false \
  -f fail_on_regression=true
```

- Do not wait for full release validation to start this early perf signal.
- Compare available Kova, gateway startup, and CLI startup metrics with earlier
  release evidence or clawgrit reports before publish/closeout.
- Call out any regression in the release proof. Treat a major regression as a
  release blocker until it is fixed, waived by the operator, or proven to be
  infrastructure noise.
- Full Release Validation records blocking product-performance evidence. The
  early standalone run is for overlap and faster regression discovery, but a
  regression or missing child run blocks the parent validation.

Prefer the trusted workflow on `main`, target the exact release SHA:

- Keep trusted-workflow checks compatible with frozen release targets. If
  `main` adds a target-owned guard script or package command after the release
  branch cut, make the trusted workflow skip only when that target surface is
  absent. Heal the trusted workflow before rerunning validation; do not port an
  unrelated runtime refactor or mutate the release candidate just to satisfy a
  newer `main`-only check.

```bash
gh workflow run full-release-validation.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f ref=<release-sha> \
  -f provider=openai \
  -f mode=both \
  -f release_profile=full \
  -f rerun_group=all
```

Use `release_profile=stable` unless the operator explicitly asks for the broad advisory provider/media matrix. Stable and full profiles force the release soak; the beta profile may opt in with `run_release_soak=true`. Use narrow `rerun_group` after focused fixes.
Publish with `openclaw-release-publish.yml` using `release_profile=from-validation`
unless a maintainer intentionally wants to cross-check a specific profile; the
publish workflow reads the effective profile from the full-validation manifest.
Pass `release_delta_evidence_run_id` only for a verified audited beta delta.
The producer records pre-tag state without requiring the release tag to
be current. Both publish workflows keep the checked-out tag SHA and
exact-target npm preflight artifact authoritative, then recheck the remote tag
peel and release-branch head immediately before promotion.

## Watch

Use the summary helper instead of repeated raw polling:

```bash
node .agents/skills/release-openclaw-ci/scripts/release-ci-summary.mjs <full-release-run-id>
```

Then watch only when useful:

```bash
gh run watch <full-release-run-id> --repo openclaw/openclaw --exit-status
```

Stop watchers before ending the turn or switching strategy.

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
6. Fix narrowly, run local/changed proof, commit, push, rerun the smallest matching group.
7. If a required PR CI run is capacity-stalled with queued jobs and no active
   jobs, do not cancel unrelated work or accept a generic manual dispatch.
   From the PR head branch, dispatch the explicit exact-SHA fallback:
   `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f
target_ref=<full-pr-sha> -f include_android=true -f release_gate=true`.
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

- release SHA
- full parent run URL
- child run IDs and conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance
- performance comparison result versus earlier releases when available
- targeted local proof commands
- provider-secret preflight result
- known gaps or unrelated failures

For lessons and recovery patterns, read `references/release-ci-notes.md`.
