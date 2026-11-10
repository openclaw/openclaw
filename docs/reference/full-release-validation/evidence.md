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
Publication always requires a successful Full Release Validation run.

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
`scripts/lib/release-validation-waivers.mjs` and is empty by default. Add a
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
selected test except for the explicit pre-dispatch exception below. A failed-job
waiver does not omit a test or change its raw conclusion.
State, manifest, and summary retain each waived failure and its reason.

The `Kova mock provider performance` leaf can be granted only for an exact
version the operator named, and only for threshold breaches; retain the report.
An `evidence: { runId, runAttempt }` restriction binds a grant to one reviewed
execution, not subsequent failures of the same job. The 2026.9.37 exception
uses this restriction for child 42361846301/1 in FRV 42361691019/1 on original
C/Q `5ca478fb3d02d7d988ce09cfcc214ec1eed46ab8`. Its retained report records the
bundled-plugin-startup gateway CPU threshold breach.

The operator additionally authorized a new 2026.9.37 candidate on November 7,
2026 at 17:49 UTC, with performance explicitly **waived-not-run**. This is the
only pre-dispatch exception: admitted P seals it into qualification coverage
after checking the exact historical failed receipt, original source, current
attempt, trusted upload, archive/payload digests, and absence of other child
failures. The historical receipt supports the exception; it does not measure
the new candidate. Q must declare `FULL_RELEASE_QUALIFICATION_EXEMPTION_CONTRACT`
version `1` and consume the verified admission before dispatch. The execution
plan omits only performance; the manifest records its explicit not-run
disposition, empty run ID, and supporting receipt identity. Strict consumers
require that record and reject presenting the old child as new-target evidence.
All remaining gates and artifact checks stay mandatory.

This cutover requires main-first trusted tooling and a deliberate qualification
harness backport to the frozen candidate, producing new C=Q and a fresh request.
Changing P alone cannot suppress the old Q dispatcher. No performance rerun,
historical evidence rewrite, threshold change, or publisher override is used.

Waiver support requires a candidate workflow that routes state operations to
admitted P. Pre-cutover frozen workflows retain strict validation; changing P
alone does not retrofit waiver support. Readers still accept the historical empty
`telegram_waiver` field without rewriting authenticated evidence.

Only exact terminal **failed** live-provider or Telegram leaves, or the
operator-authorized Kova threshold exceptions above, are eligible.
Every other required result must pass. Missing, skipped, cancelled, timed-out,
incomplete, or mismatched required evidence still blocks. Normal CI, npm/Docker
artifacts, package integrity, install/upgrade, soak, performance outside the
explicit 2026.9.37 not-run exception, plugin
prerelease, dispatch identity, and seal/evidence integrity cannot be waived.
An aggregate failure is tolerated only when its causes are entirely explained
by those exact waived leaves.

FRV must itself conclude **success** under that policy before publication can
accept it. There is no failed-but-publication-eligible verdict, publisher waiver
input, operator JSON declaration, or runtime approver lookup. Changing P only
at publication cannot retroactively authorize a failed FRV; produce successful
validation under the pinned policy first. Beta confidence deferrals remain
separate and are recorded as **not run**, never as passed or waived failures.

## Receipt-backed beta aggregate recovery

When a full beta qualification's original execution-plan artifact is unavailable,
.github/workflows/full-release-receipt-recovery.yml is a separate, explicit
trusted-main operation. It does not repair, recreate, or reinterpret the
historical plan, registry observations, or failed parent conclusion.

Its request input is a closed openclaw.full-release-receipt-recovery/v1 record:
a new request UUID, repository, original qualification-admission descriptor,
original parent run/attempt, complete sealed candidate binding, all five original
beta child selections, and original publication-artifact descriptors. Original C
must equal Q. The admission's original publication selection, complete coverage,
and frozen upgrade baselines remain authoritative; there is no new test selection
or current-registry baseline resolution.

The recovery owner authenticates the original admission and dispatches, each
current successful child attempt and its complete composite receipt, the sealed
candidate and its package bytes, and all recorded npm, SDK, plugin, and Docker
producer receipts and payload digests. Missing payloads, incomplete job history,
changed attempts, or lost authority fail closed. Each recovery child verification
has a ten-minute budget to read its complete rerun history; ordinary child reuse
keeps its two-minute default, and job-inventory request timeouts and retry limits are unchanged.
It never dispatches test or preparation workflows and has only Actions/content
read permissions. Runtime setup installs only trusted P dependencies with lifecycle
scripts disabled; it does not build or execute candidate code.

The existing publication-admission owner then reads committed candidate metadata
using current trusted P and collects new, honestly timestamped registry
observations. The new successful aggregate records a separate source/admission
and the original receipt request. Strict readers authenticate that workflow,
upload order, observation bytes, current operator authority, original evidence,
and the aggregate's trusted-main lineage. Publishers consume unchanged Q-owned
npm/plugin/Docker artifacts; P owns aggregation and current publication admission.
A retained original parent is not relabeled successful. Historical FRV validation
and historical-plan restoration remain unchanged.

Parsed payloads retain the archive owner's existing size and integrity limits.
Opaque Docker and candidate image/registry archives use its streaming digest
verification: the authenticated metadata size is the exact transfer bound, and
every byte contributes to SHA-256 without retaining or expanding the archive.
Recovery Docker archive requests may use the existing four-minute transfer budget
to finish large bodies instead of aborting each attempt after sixty seconds.
Metadata requests and other archive callers keep their sixty-second request cap;
Docker transfers still share four minutes across at most three attempts. Metadata
binding, expiry, exact size, and full-byte digest checks remain unchanged; missing
or mismatched bytes never authorize omission or rebuilding.

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/full-release-receipt-recovery.yml`
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
