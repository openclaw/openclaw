---
doc-schema-version: 1
summary: "OpenClaw release channels, version numbers, validation, and published assets"
title: "Release policy"
read_when:
  - Choosing a release channel
  - Understanding version numbers and release checks
  - Checking which packages and apps have been published
---

Choose a channel below; see [Release channels](/install/development-channels)
to switch. Maintainer procedures are linked at the end.

## Release channels

| Channel         | Distribution                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| Stable          | Regular release on npm `latest`.                                              |
| Beta            | Candidate on npm `beta`: prerelease or final awaiting promotion.              |
| Extended-stable | Trailing completed month's Gateway maintenance line on npm `extended-stable`. |
| Dev             | Moving `main` head.                                                           |

Extended-stable includes Gateway, official npm plugins, and Docker—not native
apps or ClawHub. It leaves regular stable unchanged; GitHub does not mark it
Latest. Maintain only the trailing completed month relative to `main`'s version;
when main advances a month, the previous line and older `.33+` lines retire.
Retired-line publication requires an explicit maintainer decision recorded as
`retired_line_publication_reason` in the human-approved `npm-release` receipt,
bound to the exact tag, source, channel, and parent attempt. Empty/historical
ordinary approvals do not qualify; never bypass guards or source, validation,
and live-authority gates.

## Version naming

| Release            | Example                       |
| ------------------ | ----------------------------- |
| Regular final      | `2026.9.6`                    |
| Beta prerelease    | `2026.9.6-beta.1`             |
| Regular correction | `2026.9.6-1`                  |
| Extended-stable    | `2026.8.33`, then `2026.8.34` |

- `year.month.patch` has no zero-padding; patch is a monthly release number,
  not a day. Regular patches are below `33`; extended-stable starts at `33`.
- Tags add `v` (for example `v2026.9.6`) and must be annotated and signed.
  Shared publication verifies signatures before checkout/evidence download,
  including recovery/republishing; lightweight, unsigned, and unverified tags
  are ineligible. Recover historical unsigned releases with a new signed version.
- Never replace published npm versions or tags; fixes get new versions.
  Retired alpha-only versions do not advance regular numbering.

## Release cadence

Normally publish beta, validate, then promote stable. Core and every published
official npm plugin must have `beta` at least as new as `latest`; preserve a newer
beta. Prereleases precede their same-base final. Final versions require stable
validation even when first published to beta.

## Release validation

- Stable/final publication requires stable or full validation, longer soak,
  and blocking performance checks; beta-profile evidence is insufficient.
- The release lead classifies every failed test as blocker or flake. Retain the
  failure, file a fix-in-parallel issue/PR on `main`, and rerun flakes on the
  same Release SHA at most twice. Never re-cut, change tooling, or restart FRV
  solely to clear a flake. An intentional
  [release-tooling waiver](/reference/full-release-validation/evidence#release-tooling-waivers)
  is reviewed policy requiring validation with new pinned tooling, unchanged candidate.
- Blocking coverage: CI coverage gate, seal/evidence, Build Artifacts, install
  smoke, survivor lanes, `update-first-hop-compat*`, pack/npm qualification,
  package integrity, and all Linux/Windows/macOS Gateway checks, including
  Windows packaged install/upgrade in Release Checks. All-group qualification
  includes all nine Gateway install/upgrade combinations.
- Selected `openclaw/ci-gate` must succeed unless checked-in exact-job grants
  cover every failed cause. Missing, skipped, or cancelled required coverage
  blocks. Exact failed live-provider/Telegram leaves and operator-accepted
  `2026.11.5-beta.3`/candidate-bound `2026.11.4` jobs may use that policy;
  candidate, job, version, and attempt restrictions still apply. **FRV must
  conclude success; publishers cannot waive it.**
- Coverage spans source CI, packages, plugins, Gateway installs/upgrades, and
  selected app, UI, Telegram, QA, and live-provider checks. Inspect recorded
  profile/OS coverage; skipped or deferred is not passed.
- Blocking `live-cache`: stable/full by default; beta with repo/live coverage.
  [Prompt-cache regression coverage](/help/testing/suites#prompt-cache-regression-coverage)
  defines serialized-prefix/cache-reuse checks for Anthropic Messages, OpenAI
  Responses, and credential-available OpenRouter. Live agents exercise instruction
  refresh, activated hooks, and persisted projection rehydration with full-history
  cold-transport requests—not Gateway process restart or retained HTTP continuation.
  [Offline proof](/help/testing/suites#offline-regression-ci-safe) separately compares
  authenticated chat, child completion, in-process server stop/start, and subsequent
  same-session chat (not OS-process restart). Focus: `rerun_group=live-e2e`,
  `live_suite_filter=live-cache`; `provider`/`mode` do not narrow it.
- Selected official npm plugins qualify exact publishable tarballs with immutable
  descriptors; publication uses those bytes. Unpacked fixtures participate only
  if shipped in the tarball.
- Dependency advisories never block CI, commits, or releases. Production audits
  run only for `full-release-validation-`/`release-native-android-` dispatch IDs,
  warning with exit 0; ordinary PR/push/scheduled CI skips them. The optional
  pre-commit audit agrees. Daily Dependency Audit stays strict for triage, not
  a required PR check. Record all severities; ship fixes through main after
  publication. `pnpm deps:vuln:gate` still blocks known malware.
- Red `main` CI does not gate, delay, or justify re-cutting: release-branch
  validation/publication uses pinned tooling.

See [Full release validation](/reference/full-release-validation) for profiles
and evidence interpretation.

### Operator capabilities

Repository write, organization membership, branch-policy reads, CI bypass,
environment approval, and production deployment are separate authorities.
Unavailable [prior-CI exceptions](/reference/scripts/prior-ci) neither block all
release work nor imply unavailable environment approval; MAINTAIN/CI bypass
does not authorize approval/deployment.

The checklist reports caller-specific pending approvals and prints an approval
command only if GitHub says the caller may approve; otherwise use an eligible
reviewer. Unreadable approval status is **unknown**, not none, and monitoring
continues. Anonymous rate-limit fallback applies only to public evidence, not
caller-specific approval reads.

### Resume activation while ClawHub recovery is independent

For already-published core, recovery accepts `defer_clawhub=true`,
`openclaw_npm_resume_run_id=<original-successful-run>`, and
`wait_for_clawhub=false` only with direct `publish_openclaw_npm=true` and no
`prepared_plugins`. It authenticates original registry bytes/provenance, retains
npm/source/artifact/approval/finalization gates, and neither republishes core
nor plans/dispatches ClawHub work.

Normal ClawHub publication remains default. Deferral records `clawHubDeferred`
in the authenticated dispatch receipt and incomplete ClawHub proof. GitHub,
Docker, and platform activation may continue; full release remains incomplete
until independent recovery verifies original artifacts. No repacking/replacement.

### Explicit beta plugin authentication deferrals

Only original all-package core beta publication with prepared qualification may
supply operator-reviewed `corePluginDeferrals` in `prepared_plugins` JSON—not
stable or selected-package publication. An array-only object preserves normal
publication; retain existing `npm`/`clawhub` descriptors unchanged when present.
Each entry supplies `packageName`, `version`, `sourceSha`, `reason`, and original
Actions job URL `evidence`. Allowed reasons: `npm-eneedauth` or
`npm-trusted-publisher-exchange-http-404` (verified token-exchange failure,
not arbitrary registry 404). Human-approved parent receipts bind source/tooling run.

Verify the complete original roster/artifacts, including deferrals; publish
all nondeferred packages before core. Readback retains failures and deferred
status, never invented success. Already-public deferred versions require normal
integrity/selector checks; remaining recovery needs separate authorization and
original qualified bytes.

### Watch publication

After stable dispatch, keep the read-only watcher in a separate shell:

```bash
pnpm release:stable YYYY.M.PATCH --watch
```

For any publish parent, including beta/resumes:

```bash
pnpm release:watch --run <publish-parent-run-id>
```

`release:stable --watch` authenticates retained orchestrator state; `release:watch`
derives protected tooling tag/SHA from the parent. Both correlate npm/ClawHub
children by exact parent run, attempt, and tooling identity. They stop for pending
parent/child approvals or failed runs/jobs (including `continue-on-error` Windows
notification); otherwise wait for tree success. GitHub reads only: no approval,
rerun, cancel, dispatch, or publication. Rate limits trigger extended backoff.

| Exit | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Observed tree succeeded, or `--once` found nothing needing attention.    |
| `1`  | Pending approval or failed publication run/job.                          |
| `2`  | Usage, identity, transport, truncation, timeout, or observation failure. |

`--once --json` returns `contractVersion: 1`, top-level `state` (`active`, `attention`,
`success`), and exact parent/child/approval/failed-run/failed-job records.
`--poll-seconds` overrides 60 seconds (`release:stable`) or 120
(`release:watch`); `--timeout-seconds` overrides 12 hours. Neither persists
watcher state nor creates a daemon.

### Plugin SDK evidence transport

SDK reports/evidence use `openclaw.plugin-sdk-api-encoded/v1` JSON:
`encoding: "gzip+base64"` plus a `data` string. It preserves the full logical report,
comparison digests, and channel acknowledgement; Markdown remains readable.
Inspect with `decodePluginSdkApiArtifact` in
`scripts/plugin-sdk-api-release-evidence.mjs`.

Limits: 16 MiB serialized JSON; 64 MiB expansion per decode across concatenated
gzip members—not process-wide memory. Buffers, text, objects, and concurrent
consumers coexist. Archive/file/manifest limits, immutable hashes, producer
identity, full diff validation, and acknowledgements still apply.

Upgrade producer and trusted qualification/publication readers together in the
selected tooling cut, then regenerate/qualify evidence. Frozen older readers
reject envelopes; moving main does not upgrade them. New readers accept historical
unencoded receipts. Never rewrite authenticated receipts or reuse digests for
changed bytes. This change authorizes no dispatch/publication.

### Shared qualification validation

`release-ci-summary.mjs` authenticates qualification once for all consumers;
`validate-full-release-validation-evidence.mjs` checks the release tag and
publication selection, including plugin subsets, and rechecks live authority.
Only authenticated direct admission qualifies evidence for publication.
Unadmitted historical manifests, including v3, require new admitted
qualification; ancestry alone is not admission. Receipt-backed aggregate recovery
is retired for every profile, including beta. Normal authenticated qualification
and reuse remain available, and C, Q, and P may remain independent. Existing
waiver, profile, soak, and performance rules apply. Historical manifest parsing
remains available for diagnostic summaries, not qualification or publication.

### Frozen qualification identity

| Identity                | Owns                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C — candidate**       | Exact tested/published commit, package bytes, version, upgrade baselines.                                                                                                                                 |
| **Q — qualification**   | Complete workflow/reusable-workflow/action/script/planner/contract/coverage closure; defaults to C. An independent Q requires review and verified main ancestry.                                          |
| **P — trusted tooling** | Admission, aggregate validation, verification, publication, checked-in waivers, FRV verdict; independently trusted main revision or protected publication tag. May differ from C/Q; C need not precede P. |

[Dispatch](/reference/full-release-validation/dispatch) defines P's immutable
operator-attestation/input/coverage admission before Q's `release-ci/*` dispatch.
`release-publish/*` belongs to P. Admission is not test success/publication approval.

`pnpm release:candidate --workflow-sha <P>` pins helper/publication, not Q;
`pnpm ci:full-release --trusted-workflow-ref candidate --workflow-sha <Q>`
selects reviewed Q through P. Follow
[qualification-tooling recovery](/reference/full-release-validation/dispatch#recover-qualification-tooling-without-changing-the-candidate):
fresh request/admission/successful parent for changed Q, deliberate Q repair or
backport for missing contracts, new bound evidence for changed C. P-only repairs
may retain C/Q/artifacts. No moving-main fallback or relabeling old requests.
Historical requests retain recovery semantics; new publication requires admitted
C/Q/P, not diagnostic cross-revision evidence.

Stable `npm-stable-v1`/admitted stable/full include reusable mock-provider
Telegram proof for exact FRV-qualified bytes; `npm-beta-v1` is deferred, not passed.
Historical separately packed/live-provider Telegram checks need their own C-byte
proof. Supplemental checks require retained `release-ci/*` verified at Q and
`harness_ref` pinned to Q; missing/moved refs require new candidate evidence.
Keep run IDs in the candidate bundle, not optional publisher postpublish
diagnostics. Local Parallels uses isolated Q harness/frozen dependencies against
exact validated C tarballs when Q differs.

Reuse preserves producer/consumer identities, inputs, coverage, and provenance.
[Root-request recovery](/reference/full-release-validation/dispatch#retain-and-reconcile-the-root-request)
owns read-only reconciliation and explicit pre-POST resume: intended Q, empty
uncertain-ref inventory, revalidated admission/signer, final ref verification.
Attempted/uncertain POSTs are observation-only, never redispatched. Publication,
soak, performance, approval, and exact-byte gates remain.

Local contracts prove binding/refusal/recovery—not hosted admission, environment
access, OIDC, signing, or publication. Report hosted evidence and untested
prerequisites separately; local green is not a hosted receipt.

## Packages and apps can become available at different times

Selected official npm plugins publish before core (except explicit beta deferrals
above). ClawHub starts at its existing dispatch point, then runs independently;
its planning/authorization/dispatch/publication/verification/recovery never block
core npm, GitHub finalization, main closeout, or retrospective PR. Keep pending/
failed ClawHub work visible with owner/follow-up; core success does not complete it.

Native signing/publication may finish separately from npm, Docker, and GitHub.
Check platform assets/announcements: a published Gateway, pending app build,
or accepted request does not prove app publication. Extended-stable excludes apps.

## Release notes and verification

[Release notes](/releases) describe user changes; GitHub carries validation,
dependency, and package checks identifying tested versions/shipped files.
Documentation updates do not rebuild/replace packages.

Beta notes freeze each beta's changelog/contribution record against npm's
prepublication `beta` selection—even stable when beta/latest coincide—not
necessarily the last GitHub prerelease. Stable notes accumulate since previous stable.

[Dependency locking](/gateway/security/dependency-locking) covers review;
release archives carry npm-format locks separately from tarballs.

### Downstream packaging

1. Download `openclaw-<version>-dependency-evidence.zip` from GitHub release assets;
   select the exact `packages` entry by name/version in
   `dependency-evidence/npm-package-locks.json` (`schemaVersion: 1`).
2. Reject nonempty `omittedWorkspaceDependencies`: partial locks omit sibling
   runtime `workspace:` dependencies published together; counted in
   `packagesWithOmittedWorkspaceDependencies`.
3. Match `dependency-evidence/dependency-evidence-manifest.json`'s `releaseSha`,
   report `sourceSha`, and pinned OpenClaw commit. Report also records source
   `pnpm-lock.yaml` SHA-256.
4. Serialize `entry.lock` as `package-lock.json` (two-space indentation,
   trailing newline); verify SHA-256 against `entry.lockSha256`.
5. Before `npm ci`, copy source `pnpm-workspace.yaml` overrides into consuming
   `package.json` or rewrite nested `dependencies`/`optionalDependencies` to
   locked versions; otherwise encoded overrides can fail npm lock-sync.

Companion `npm-package-locks.md` lists package/count tables.
`bundleRuntimeDependencies`/direct counts identify lockless packages needing
external locks. Path-sorted `bundledDependencies` records `path`, `name`, `version`,
`parent` and lock `inBundle: true`. Parent is the nearest non-bundled carrier;
its `resolved`/`integrity` verify the containing tarball. Reports reject missing/
unverifiable carriers, preserve lock payloads, and count bundles per package/total.

## Maintainer procedures

Preparation, publishing, approvals, and recovery: the
[release-maintainer skill](https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-maintainer).
Credentials/emergencies: private maintainer runbook. Legacy anchors follow.

<a id="linux-companion-publication" />

[Linux publication](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/platform-publication.md#linux).

<a id="release-changelog-artifacts" />

[Release changelogs](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/preparation.md#changelog-and-release-notes).

<a id="changelog-only-evidence-reuse" />

[Changelog-only qualification](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#qualify-publication-bytes).

<a id="monthly-gateway-extended-stable-publication" />
<a id="prepare-and-stabilize-the-candidate" />
<a id="publish-the-npm-packages" />
<a id="publish-the-release" />

[Extended-stable preparation and publication](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/extended-stable-publish.md).

<a id="verify-and-recover" />

[Extended-stable recovery](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/extended-stable-publish.md#trusted-main-npm-recovery).

<a id="regular-release-operator-checklist" />
<a id="fast-path-default" />
<a id="fast-path-(default)" />
<a id="stable-release-process" />
<a id="full-checklist" />
<a id="manual-fallback" />

[Regular release checklist](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#freeze-and-validate-code).

<a id="orchestrated-stable-release" />

[Resumable release orchestration](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#orchestrated-stable-release).

<a id="release-priority" />

[Deferred CI recovery](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#deferred-ci-recovery).

<a id="continuous-release-readiness" />

[Nightly validation reuse](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#continuous-release-readiness).

<a id="release-tooling-fast-lane" />

[Release tooling CI scope](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#release-tooling-fast-lane).

<a id="stable-main-closeout" />

[Stable main closeout](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/stable-main-closeout.md).

After every stable release, regenerate the committed shipped Plugin SDK surface
on `main` with `pnpm plugin-sdk:shipped-surface:gen -- --release <stable tag>`,
then run `pnpm plugin-sdk:surface:check`. Commit the generated
`scripts/lib/plugin-sdk-shipped-surface.json` as part of stable closeout; do not
edit it by hand. The inventory records the stable tag's typed public declarations
so later export-budget reductions cannot authorize their removal.

<a id="post-release-documentation-publication" />

[Post-release documentation publication](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-changelog-update/SKILL.md#post-release-docs-mirrors).

<a id="release-preflight" />
<a id="required-checks" />

[Source and package gates](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/validation.md#source-and-package-gates).

<a id="previous-updater-compatibility" />

[Older updater verification](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/validation.md#older-updater-checks).

<a id="design-proposal%3A-immutable-runtime-generations" />
<a id="design-proposal-immutable-runtime-generations" />

[Runtime generation design proposal (not shipped behavior)](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/validation.md#immutable-runtime-generation-proposal).

<a id="release-test-boxes" />
<a id="vitest" />
<a id="docker" />
<a id="qa-lab" />

[Release validation lanes](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#dispatch).

<a id="package" />

[Package Acceptance](/ci/release-validation/package-acceptance).

<a id="regular-release-publish-automation" />
<a id="check-publication-gates" />

[Publication qualification](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#qualify-publication-bytes).

<a id="probe-the-bootstrap-token" />

[Bootstrap-token verification](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/publication-recovery.md#check-the-bootstrap-token).

<a id="prepare-once%2C-then-use-the-release-button" />
<a id="prepare-once-then-use-the-release-button" />

[Prepared publication](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#prepared-publication).

<a id="recover-a-failed-download" />

[Interrupted preparation and publication](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/publication-recovery.md#interrupted-preparation-and-publication).

<a id="direct-publication-and-owner-recovery" />

[Published-version recovery](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/publication-recovery.md#published-version-failed-parent).

<a id="npm-workflow-inputs" />
<a id="regular-beta%2Flatest-stable-release-sequence" />
<a id="regular-beta/latest-stable-release-sequence" />

[Regular publication and verification](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-maintainer/references/regular-release.md#publish-and-verify).

<a id="publication-modes%3A-strict-default-and-operator-fast-path" />
<a id="publication-modes-strict-default-and-operator-fast-path" />

<a id="publication-requirements" />

[Publication requirements](https://github.com/openclaw/openclaw/blob/main/.agents/skills/release-openclaw-ci/SKILL.md#publication-requirements).

<a id="public-references" />
<a id="related" />

[Release workflow reference](/reference/full-release-validation).
