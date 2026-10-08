---
doc-schema-version: 1
summary: "OpenClaw release channels, version numbers, validation, and published assets"
title: "Release policy"
read_when:
  - Choosing a release channel
  - Understanding version numbers and release checks
  - Checking which packages and apps have been published
---

OpenClaw offers stable releases for everyday use, beta releases for testing,
and extended-stable releases for users who prefer an older Gateway maintenance
line. This page explains those choices and what a release has been checked for.
For switching channels, see [Release channels](/install/development-channels).

## Release channels

| Channel         | What you get                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| Stable          | The regular release promoted to npm `latest`.                                              |
| Beta            | A candidate on npm `beta`. This may be a prerelease or a final version awaiting promotion. |
| Extended-stable | A Gateway maintenance release from the trailing completed month, on npm `extended-stable`. |
| Dev             | The moving head of `main`, for development.                                                |

Extended-stable includes the Gateway, official npm plugins, and Docker images.
It does not include native apps or ClawHub publication, and it does not change
the regular stable channel. Its GitHub release is not marked Latest. A monthly
line retires when `main` advances into the next month.

## Version naming

| Release            | Version example                                                       |
| ------------------ | --------------------------------------------------------------------- |
| Regular final      | `2026.9.6`                                                            |
| Beta prerelease    | `2026.9.6-beta.1`                                                     |
| Regular correction | `2026.9.6-1`                                                          |
| Extended-stable    | `2026.8.33`, followed by `2026.8.34` for its next maintenance release |

Versions use `year.month.patch`, without zero-padding. The patch is a release
number within the month, not a day of the month. Regular releases use patches
below `33`; extended-stable starts at `33`. Git tags add `v`, as in `v2026.9.6`.
Release tags are annotated and signed. The shared publication workflow verifies
the tag signature before checkout or evidence downloads and refuses lightweight,
unsigned, or unverified tags. This also applies to recovery and republishing:
historical unsigned tags are not eligible for the shared publication workflow,
and recovery must use a new signed release version rather than replacing a tag.

Published npm versions and release tags are never replaced. A fix receives a
new version. Historical alpha-only versions do not advance the regular release
number; alpha releases are retired.

## Release cadence

Releases normally go to beta first and move to stable after validation.
For core and every published official npm plugin, `beta` must be at least as
new as `latest`; an already newer beta stays unchanged. A prerelease is older
than the final version with the same base number.

A final version published to the beta channel still has to meet the stable
validation requirements below. The npm channel alone does not determine which
checks apply.

## Release validation

Stable publication requires stable or full validation, longer-running soak tests,
and blocking performance checks. These requirements also apply to a final version
first published on the beta channel. Beta-profile evidence cannot qualify stable.

Every failed test needs an explicit release-lead decision: blocker or flake.
Rerun a flake on the same Release SHA at most twice, file its fix-in-parallel
issue or PR on `main`, and retain the original failure. Do not re-cut, change
tooling, or start another Full Release Validation solely to clear a flake; a
selected job that remains red blocks publication.

Blocking jobs include the CI coverage gate, seal/evidence,
Build Artifacts, install smoke, survivor lanes, `update-first-hop-compat*`, pack/npm
qualification, package integrity, and all Linux/Windows/macOS Gateway checks,
including Windows packaged install/upgrade checks in Release Checks. A cancelled
run still blocks. The selected `openclaw/ci-gate` must succeed; failed, missing,
skipped, or cancelled coverage blocks. Publication waivers cannot bypass failures
or required coverage. Validation covers source CI, packages, plugins,
Gateway installs and upgrades, and selected app, UI, Telegram, QA, and
live-provider checks. All-group qualification includes all nine Gateway
install/upgrade combinations across Linux, Windows, and macOS. Coverage otherwise
varies by profile and selected operating systems. Check the release's recorded
coverage: skipped or deferred checks are not passes.

For selected official npm plugins, Full Release Validation packs and qualifies
the exact tarballs intended for publication and records their immutable artifact
descriptors. Publication consumes those same bytes. Unpacked source fixtures do
not participate unless npm includes them in a shipped tarball.

Dependency advisories never block CI, local commits, or delay a release. Ordinary
pull-request, push, and scheduled CI skip the production dependency audit. It
runs only for release dispatch IDs beginning with `full-release-validation-`
or `release-native-android-`, where every audit failure is a warning with exit
code 0. The optional production audit pre-commit hook follows the same policy.
The separate daily Dependency Audit stays strict for triage and is not a required
PR check. Release dependency evidence records every advisory finding, at any
severity. The dependency fix ships through `main` after publication. The release
`pnpm deps:vuln:gate` still stops publication on known malware, which identifies
a compromised package rather than a vulnerability advisory.

The health of `main` CI does not gate a release. Validation and publication run
from the release branch with pinned release tooling, so a red `main` is not a
reason to wait, re-cut, or pause.

See [Full release validation](/reference/full-release-validation) for coverage
by profile and how to interpret the results.

### Frozen qualification identity

New candidate qualification records three separate identities:

- **C — candidate:** the exact commit whose source and publication bytes are checked.
- **Q — qualification:** the full workflow closure at C, including reusable workflows,
  local actions, scripts, planners, contracts, and coverage data. By default **Q=C**.
- **P — admission, verification, and publication tooling:** an independently trusted
  main revision or protected publication tag. P may differ from C/Q; C/Q does not
  need to be an ancestor of P. Trust in P does not replace qualification of C.

The canonical SHA-pinned helper first asks P to record the reviewed operator
attestation, complete normalized inputs, and data-only frozen Q coverage in an
immutable admission artifact. Only then does that same helper dispatch Full
Release Validation from an immutable `release-ci/*` ref at Q. A publication
`release-publish/*` tag belongs to P, never to Q merely to make validation run.
Admission is not a successful test result or publication approval.

A candidate missing the required qualification contracts needs a deliberate
backport. The helper does not silently use future-main checks or import
main-only scenarios. A repair to the qualification harness changes C and Q and
requires newly bound evidence; a P-only verifier/publisher repair can preserve
C/Q and their original artifacts. Explicit trusted-main or protected-tag
cross-revision validation is limited to diagnostic, main-qualification, and
postpublish-confidence requests. It cannot supply new final candidate
qualification. Existing historical publish requests keep their original meaning
and remain recoverable. New publish qualification requires admitted Q=C.

Evidence reuse preserves both the original producer identity and the current
consumer identity, inputs, coverage, and artifact provenance. It cannot relabel
an old run as candidate-owned. Reconciliation is read-only; explicit resume is
limited to a candidate request before any qualification-ref mutation or FRV
dispatch. An uncertain write never authorizes another dispatch. All publication
gates, stable soak, blocking performance, environment approvals, and exact-byte
checks remain unchanged.

Local contract tests can prove input binding, refusal, and recovery behavior.
They do not prove hosted workflow admission, environment access, OIDC, signing,
or publication. Report hosted evidence and untested deployment prerequisites
separately; a local green check is not a hosted release receipt.

## Packages and apps can become available at different times

A published Gateway release does not mean every native app is ready. Signing and publishing the apps can
finish separately from npm, Docker, and the GitHub release.

Check the release's assets and announcements for each platform. A pending app
build or an accepted publication request is not a completed app release.
Extended-stable is a Gateway distribution and does not publish native apps.

## Release notes and verification

The [release notes](/releases) describe user-facing changes. GitHub releases
also carry validation results, dependency reports, and checks of the published
packages. These records identify the tested version and the files that shipped.
Later documentation updates may improve the release notes without rebuilding
or replacing packages.

Beta release notes show changes since the version selected by npm's `beta`
channel before publication. That baseline can be a stable version when `beta`
and `latest` select the same package; it is not necessarily the last GitHub
prerelease. Each beta freezes its own changelog and contribution record.
Stable release notes remain cumulative since the previous stable release.

For dependency review, see [Dependency locking](/gateway/security/dependency-locking).
Release dependency archives include npm-format locks separately from the
package tarballs.

### Downstream packaging

To consume a release lock:

1. Download `openclaw-<version>-dependency-evidence.zip` from the GitHub release.
   Open `dependency-evidence/npm-package-locks.json` (`schemaVersion: 1`) and
   select the `packages` entry matching the exact package `name` and `version`.
2. Reject entries with a nonempty `omittedWorkspaceDependencies` array. These
   are partial locks: the generator omits sibling `workspace:` runtime dependencies
   that publish in the same release. The report counts these entries in
   `packagesWithOmittedWorkspaceDependencies`.
3. Verify that `dependency-evidence/dependency-evidence-manifest.json`'s
   `releaseSha`, the report's `sourceSha`, and the OpenClaw commit you pin all
   match. The report also records the source `pnpm-lock.yaml` SHA-256.
4. Serialize `entry.lock` as `package-lock.json` using two-space JSON indentation
   and a trailing newline, then verify its SHA-256 against `entry.lockSha256`.
5. Before `npm ci`, carry the source `pnpm-workspace.yaml` overrides into the
   consuming `package.json`, or rewrite nested `dependencies` and
   `optionalDependencies` specs to their locked versions. The generated locks
   encode workspace overrides, so unmodified specs can fail npm's lock-sync check.

The companion `npm-package-locks.md` includes counts and a package table. Each
entry records `bundleRuntimeDependencies` and direct dependency counts so
packagers can identify lockless packages that need an external lock.
Each entry also records a path-sorted `bundledDependencies` array with `path`,
`name`, `version`, and `parent`. These dependencies carry `inBundle: true` in the
npm lock; `parent` identifies the nearest enclosing non-bundled package whose
`resolved` and `integrity` verify the tarball carrying their bytes. The report
rejects missing or unverifiable carriers and preserves the lock payload. The
Markdown table counts bundled dependencies per package and includes their total.

## Maintainer procedures

Release preparation, publishing commands, approvals, and recovery live in the
[release-maintainer skill](https://github.com/openclaw/openclaw/tree/main/.agents/skills/release-openclaw-maintainer).
Credential handling and emergency procedures remain in the private maintainer
runbook. Former section links below lead to their corresponding procedures.

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
