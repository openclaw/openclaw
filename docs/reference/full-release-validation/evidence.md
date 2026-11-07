---
doc-schema-version: 1
summary: "Full Release Validation evidence, checked-in release-tooling waivers, and backing workflows"
title: "Evidence to keep"
read_when:
  - Recording release evidence after a validation pass
---

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. Classify failures as product,
harness/tooling/provenance, infrastructure/credential, or wrapper. Only a
confirmed product failure changes the Code SHA. Use one diagnosis, one fix when
needed, and one narrow retry, then reassess; do not automatically rerun `all`.
Narrow evidence is not publish authorization by itself.

Decide blocker or flake for every failed test. Every selected failure blocks
validation unless it matches the checked-in release-tooling policy below.
Publication requires successful Full Release Validation or the exact retrospective
policy re-evaluation described below. Failed results remain failed evidence.

Linux, Windows, and macOS Gateway cross-OS install and upgrade lanes are
required for beta, stable, and full validation. The manifest records their
actual conclusions, and failures block the release decision. Keep diagnostic
artifacts; never report a failed, omitted, or deferred lane as passed.

For a regular release, record Code SHA and Release SHA even when they are the
same commit. In that case, retain the successful full validation parent and
its exact prepared publication artifacts for both roles. For a later
changelog-only Release SHA using evidence reuse, also record the reuse policy,
complete changed-path set, green Code SHA parent run, and Release SHA parent
run. For extended-stable, record the release branch, exact release SHA,
accepted producer identity, parent run id and attempt, workflow ref, every child run, and any
frozen-target compatibility repair or intentional omission.

Useful artifacts:

- The attempt-one `full-release-execution-plan-<parent-run-id>` and current
  `full-release-validation-<parent-run-id>-<attempt>` manifest retain source
  facts and registry admission, including observations, exact selection,
  immutable upload identity, and admission-time freshness. Reuse retains distinct
  original and current records without restamping either. Authentication requires
  the original successful admission and guarded upload, not an overall successful
  sealer job: an interrupted sealer can still write and upload a complete plan.
  Later attempts never replace that original artifact.
- `release-package-under-test` from `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, runtime parity, and selected Matrix, Buzz, Telegram, Discord,
  WhatsApp, or Slack artifacts

Readers authenticate retained evidence; they do not refresh registry observations
or expire it by the current clock. Registry admission is not publication authority
or a promise that registry state is unchanged. Final writers keep their own trust,
approval, content, and readback checks. Known enclosing evidence is budgeted before
fanout, but later job/attempt growth can still exceed the unchanged final artifact
limit and fail sealing; evidence is not truncated to fit.

<a id="publication-waivers" />

## Release-tooling waivers

Waivers are code in trusted release tooling **P**, not candidate **C** or its
qualification harness **Q=C**. The grant list is
`scripts/lib/release-validation-waivers.mjs`. Add a
reviewed row with an exact target version, child role, job name, and reason.
For example (illustrative only, not an active grant):

```js
export const RELEASE_VALIDATION_WAIVERS = [
  {
    targetVersion: "YYYY.M.PATCH",
    childRole: "releaseChecksIndependent",
    jobName: "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)",
    reason: "Provider credential outage; tracked in the release handoff.",
  },
];
```

Land the policy in trusted tooling, pin that **P** when admitting validation,
and run or revalidate FRV with the unchanged **C/Q**. P's
`full-release-validation-state.mjs` owns Release Decision, Diagnostic Drain,
manifest writing, and final validation. Candidate workflows still run every
selected test; a waiver does not omit a test or change its raw conclusion.
State, manifest, and summary retain each waived failure and its reason.

The `Kova mock provider performance` leaf can be granted only for an exact
version the operator named, and only for threshold breaches; retain the report.

Waiver support requires a candidate workflow that routes state operations to
admitted P. Pre-cutover frozen workflows retain strict validation; changing P
alone does not retrofit waiver support. Readers still accept the historical empty
`telegram_waiver` field without rewriting authenticated evidence.

Only exact terminal **failed** live-provider or Telegram leaves are eligible.
Every other required result must pass. Missing, skipped, cancelled, timed-out,
incomplete, or mismatched required evidence still blocks. Normal CI, npm/Docker
artifacts, package integrity, install/upgrade, soak, performance, plugin
prerelease, dispatch identity, and seal/evidence integrity cannot be waived.
An aggregate failure is tolerated only when its causes are entirely explained
by those exact waived leaves.

### Apply a waiver after validation

A completed, failed candidate-owned FRV can be re-evaluated without dispatching
another validation cycle. Add a reviewed entry to
`RELEASE_VALIDATION_RETROSPECTIVE_WAIVERS` in the same trusted-P policy module:

```js
{
  parentRunId: "12345678901",
  parentRunAttempt: 1,
  targetSha: "0123456789abcdef0123456789abcdef01234567",
  targetVersion: "YYYY.M.PATCH",
  childRole: "releaseChecksIndependent",
  jobName: "Run repo/live E2E validation / Native live suites (Native live Z.AI Coding Plan)",
  reason: "Provider outage; release-manager decision and investigation in the handoff.",
}
```

After that policy lands, pin the new trusted P for the normal candidate
checklist/publication preflight and select the **original** FRV run and attempt.
The strict evidence reader authenticates its original admission, execution plan,
manifest, complete child attempts, failed aggregate logs, and publication bytes.
It re-evaluates the exact failed leaves under P and emits a separate
`retrospectiveWaivers` record in its verified evidence. That record identifies the
source run/attempt, candidate SHA, current tooling SHA, and applied reasons.
The original manifest and GitHub conclusions are not modified or relabeled green.
The publisher consumes this same strict verdict; there is no runtime waiver input.

This requires a retained manifest from a direct, all-group candidate-owned run.
FRV now uploads that immutable snapshot before enforcing its final verdict.
Older failures without this artifact cannot be reconstructed by the publisher;
run validation with snapshot-capable tooling instead. Evidence-reuse chains,
missing or expired artifacts, incomplete/cancelled children, and parent failures
outside the two policy-verdict steps remain blocking. The diagnostic drain and
all non-waived required results must still pass. Independent npm/Docker artifact
producer runs retain their successful-parent requirement; a retrospective waiver
never repairs a failed artifact producer or bypasses package qualification.

Prospective waivers still require FRV success under pinned P. Retrospective
grants are limited to supported provider-specific native live suites, the live
cache leaf, and Telegram leaves. Generic Gateway, infrastructure, preparation,
and Docker jobs are not eligible. These grants cannot
waive performance, soak, CI, install/upgrade, identity, or integrity. Existing
publication approvals and current admission authority remain required. Beta
confidence deferrals remain separate and are recorded as **not run**, never as
passed or waived failures.

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/full-release-candidate.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/install-smoke-reusable.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
- `.github/workflows/openclaw-performance.yml`
- `.github/workflows/npm-telegram-beta-e2e.yml`
