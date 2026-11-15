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

## Bounded publication recovery

A publisher may consume a nonempty selected plugin subset of an authenticated
all-publishable admission without changing the original qualification. The
operation retains the original release, channel, route, Windows operands, and
sealed artifact identities. It does not create a replacement admission or make
selected evidence sufficient for a broader publication. Each batch uses a new
parent authorization and retains current authority checks at the final effect.

Prepared npm consumers authenticate the complete original manifest before
selecting that batch's entries. Already-published npm packages are excluded from
publication fanout only after exact registry-byte verification. Before core npm
publication, the parent verifies the complete original npm roster after the
plugin child finishes; missing packages or mismatched bytes block core publication.

ClawHub recovery uses the original child's authenticated recovery seal and
transaction roster, not a replacement prepared manifest. A publication parent
can name the original ClawHub run and attempt and dispatch the existing recovery
workflow. Its sealed dispatch payload binds the exact original child, selected
plugins, current parent, and full validation run. Recovery keeps the existing
ClawHub environment and credential, verifies current parent authorization before
every recovery request, and verifies exact public bytes. A selected batch does not
claim completion of excluded packages. Before core publication, a full-scope
parent waits for recovery of the complete original roster. Manual recovery without
parent inputs retains the existing full-roster behavior.

Recovery records a validated successor attempt in its existing result artifact
before waiting for publication. Parent-requested recovery also updates the
postpublish evidence attempt roster. A timeout or failed observation preserves
the last observed status with incomplete evidence; it does not mean the accepted
attempt disappeared or permit replacement publication. The original sealed
manifest remains unchanged.

When authenticated job evidence proves that the original publisher never ran,
the parent can instead restore the original sealed package bytes through the
existing prepared-artifact consumer. Successful original pack jobs authenticate
the source even if the enclosing child failed before publication. Original
source identity remains separate from the new publishing child and its current
parent authorization; this path does not invent a successful preparation run,
previous publication attempt, or historical authorization. The complete original
admission and seals are authenticated before selecting packages. A fresh
authoritative registry check must report each selected package absent before
initial publication; pending, failed, unknown, or ambiguous state stops the path
for original-attempt reconciliation. No package is repacked. The parent keeps
this child active through authorization and exact public readback, even when
optional ClawHub waiting or core publication is disabled. Core publication cannot
start before this original-byte batch is verified. Ordinary releases retain their
existing authorization placement after core startup; both paths use the same
transaction authorization owner.

Prepared npm preview checks the current workflow token's REST core allowance
before emitting its publisher matrix. It budgets 512 requests per selected
package (256 each for `consume` and `authorize`) and leaves 1,024 requests of
headroom for final authority checks and surrounding workflow work. Each command
enforces its own ceiling across `gh` and artifact HTTP transports, including
explicit pagination, retries, and archive API requests. Preview itself is bounded
to 1,024 requests. Exhaustion fails closed; it never skips authority or byte
verification. Command accounting reports the actual attempted requests, not just
metadata fetches. The earlier `fetch-metadata-only` telemetry remains partial.

An oversized selection fails before matrix or evidence-handoff output and reports
the supported smaller selection and quota reset time. For example, 98 packages
require an allowance of 51,200 under these ceilings; a token with 5,000 remaining
can admit at most seven. This is admission, not a claim that the existing
per-package authentication now uses fewer requests or that all 98 packages can
finish in one hour. Resume smaller selections after the observed reset with fresh
parent authorization; original bytes and per-package receipts remain unchanged.

The allowance is an observation, not a global reservation. Other workflows,
parent/ClawHub work, action-internal requests, and manual retries can consume the
same installation quota. The headroom is not an enforced budget for those owners;
coordinate their capacity separately. A later quota failure still requires
original-attempt reconciliation, not blind re-publication.

<a id="publication-waivers" />

## Release-tooling waivers

Waivers are code in trusted release tooling **P**, not candidate **C** or its
qualification harness **Q=C**. The grant list is
`scripts/lib/release-validation-waivers.mjs` and is empty by default. Add a
reviewed row with an exact target version, child role, job name, and reason.
For example (illustrative only, not an active grant):

```js
const RELEASE_VALIDATION_WAIVERS = [
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

The operator also authorized exact-job failure grants for `2026.11.5-beta.3`
on November 14, 2026 at 13:30 UTC: the recorded UI reply-navigation shard,
Android screenshots, Google Decision and Gateway runtime shards, and Docker
package/update OpenAI test job from FRV `43594812558/1`. The checked-in list
is authoritative. These accept failures of those named jobs, not only the
individual observed assertions. Raw failures remain visible; the CI and release
aggregates must contain only causes explained by granted jobs. This exception
does not carry to another release or excuse package/receipt integrity failures.

Only exact terminal **failed** live-provider or Telegram leaves, the beta.3
operator-accepted jobs, or the Kova threshold exceptions above are eligible.
Every other required result must pass. Missing, skipped, cancelled, timed-out,
incomplete, or mismatched required evidence still blocks. Normal CI outside
the exact beta.3 grants, npm/Docker artifact production, package integrity,
install/upgrade outside the named Docker test job, soak, performance outside the
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

<a id="receipt-backed-beta-aggregate-recovery" />

## Receipt-backed aggregate recovery

When a reviewed P-only policy or tooling change requires a new aggregate,
`.github/workflows/full-release-receipt-recovery.yml` is a separate, explicit
trusted-main operation over existing qualification receipts. It also supports
recovery when the original execution-plan artifact is unavailable. It does not
repair, recreate, or reinterpret the historical plan, registry observations, or
failed parent conclusion.

The original admission determines the profile and complete child inventory:
`beta`, `stable`, and `full` are supported, including extended-stable publication.
A profile is not a release track: regular stable can use `npm-stable-v1`, while
full and extended-stable retain their unreduced coverage. Extended-stable retains
its original branch/version rules, dist-tag, publication selection, and frozen
upgrade baselines.

Use the retained operator entry point (this dispatches only the recovery workflow,
not tests or artifact preparation):

```bash
pnpm frv recover --run <original-parent-run-id> \
  --workflow-sha <exact-trusted-main-P> --request-file <private-request-path>
pnpm frv recover --reconcile-request <private-request-path> --json
```

The helper derives descriptors from the original source admission, authenticated
execution plan when available, and sealed child/publication artifacts. With no
plan, it requires original exact dispatch logs plus candidate, npm, Docker, and
plugin preparation receipts. Missing or ambiguous evidence fails closed; there
is no manual tuple-entry override. An existing but invalid plan does not enable
the missing-plan fallback. Adopted children are also discoverable without a
retained plan: the exact original `Reused` run/attempt witness and
`FRV_CHILD_REUSE_SHA256` must match the selection reconstructed from the original
child receipt and artifact metadata. The existing receipt owner still verifies
its origin, admitted inputs, current attempt, and sealed workload; missing or
changed adoption witnesses are refused.

The private request records a new UUID and exact P before dispatch; the helper
marks it attempted durably before its single POST. P must still be the main tip;
the workflow independently requires its actual SHA to equal requested P. A move
in that small API window fails rather than silently adopting newer tooling.
Reopening the request or using `--reconcile-request` only reads the bounded
100-run recovery inventory, matching exact title, P, repository, workflow, and
attempt. An exact title is only a candidate: authenticated request observation
requires the canonical `request.json` bytes from the exact P/attempt, with the
ordered successful retain/upload steps and artifact timestamp. The early
`full-release-recovery-request-<run>-<attempt>` artifact can establish request
identity even if later recovery fails; it does not establish qualification or
publication authority. Missing witnesses stay unconfirmed, never permission to
retry. A successful aggregate additionally passes the existing strict recovery
authenticator, and reconciliation rechecks the current attempt after reads.
Preserve the file after interruptions or rejected requests; neither a running
nor a successful recovery run alone replaces strict publication verification.

Its request input is a closed openclaw.full-release-receipt-recovery/v1 record:
a new request UUID, repository, original qualification-admission descriptor,
original parent run/attempt, complete sealed candidate binding, original admitted
child selections, and original publication-artifact descriptors. New operator
requests also bind the exact recovery workflow SHA; historical v1 requests without
that optional field remain readable. Original C must equal Q. The admission's original publication selection, complete coverage,
and frozen upgrade baselines remain authoritative; there is no new test selection
or current-registry baseline resolution.

Required workload inventory is checked for both direct and recovered qualification,
including selected soak, install, platform, package, and live-channel work. Advisory
failures and authenticated waivers retain their existing policy. The Docker package
planner currently supports the same frozen policy implementation as P: if Q’s
planner or its policy dependencies differ, verification fails explicitly and needs
a reviewed frozen-policy adapter. It never substitutes P’s package-recovery pins,
support floors, or expansion rules for a different Q policy.

The recovery owner authenticates the original admission and dispatches, each
current policy-passing child attempt and its complete composite receipt, the sealed
candidate and its package bytes, and all recorded npm, SDK, plugin, and Docker
producer receipts and payload digests. Only the candidate version authenticated by
the original admission selects checked-in P-owned waivers. Recovery rechecks exact
failed aggregate causes, preserves raw child conclusions, and records the matched
waivers in its new seal. Strict readers independently recompute that policy and
reject added or omitted waivers. Previously reused children retain their original
dispatch origin; recovery checks the original qualification parent’s exact reuse
digest witness with the same validator used by ordinary aggregation. Ordinary
green-only child reuse is unchanged.
Missing payloads, incomplete job history, changed attempts, or lost authority fail
closed. Each recovery child verification
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

The recovery producer hashes and inspects the original payloads once and seals
that exact inventory in the aggregate. Publication readers first authenticate the
successful recovery job, ordered uploads, and observation bytes. They then
reconstruct the complete inventory from the original descriptors, small manifests,
and live artifact metadata and require an exact match with the sealed inventory.
Bulk npm, SDK, Docker, and candidate bodies are not downloaded again by every
plugin publisher. A fresh bounded plugin-artifact listing replaces per-package
metadata requests; it is local to that authentication, never immutable replay.
Selected package consumers still download and verify their own original bytes,
and current producer attempts, expiry, and operator authority remain mandatory.
The immutable replay carries raw small evidence only; its limits are unchanged.

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
