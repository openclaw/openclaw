---
doc-schema-version: 1
summary: "Dispatching Full Release Validation: Code SHA and Tooling SHA selection, helper inputs, and the immutable execution plan"
title: "Dispatch a validation run"
read_when:
  - Starting a Full Release Validation run
  - Selecting the Code SHA, Release SHA, and Tooling SHA
---

`Full Release Validation` is the release product-validation umbrella. Most work
happens in child workflows so a failed box can be rerun without restarting the
whole release. Run release preparation before freezing the Code SHA; it
refreshes Control UI locale output when the background bot has not landed it
yet, then enforces the same strict zero-fallback check used by release CI.

Generated-locale drift is a warning before dispatch, not a reason to refuse
validation. Source PRs and the serialized locale-refresh workflows land
separately, so generated output can temporarily lag. Record any preflight drift
against the frozen target SHA and continue dispatch. The normal-CI child still
runs strict `control-ui-i18n` and `native-i18n` jobs; their failures remain visible
in the run summary and fail validation. PR-side locale checks, release preparation,
and publication requirements are unchanged.

Linux (`ubuntu`), Windows, and macOS Gateway cross-OS fresh-install and upgrade
lanes gate publication in the beta, stable, and full profiles. A failure blocks
Release Decision, npm publish, and `pnpm release:candidate`. Retain each lane's
actual conclusion in the manifest and summary; selected lanes need terminal
evidence.
Normal CI, npm qualification, Docker, Package Acceptance, and the profile's
performance and soak requirements keep their existing gates.

Prepare the complete history manifest and substantive version-matched release
notes before freezing the product-complete commit and its target context as the
**Code SHA/ref**. Package source preflight requires a matching release section;
an empty placeholder is not preparation. If the notes are final, this commit
can also be the **Release SHA**. Select one trusted workflow commit and context
as the **Tooling SHA/ref**, then run:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

This example selects normal final-release publication. Select `npmDistTag=beta`
for a beta, or `route=prepared` when the intended consumer is the prepared release
button. Core publication requires `all-publishable` plugins. Plugin-only normal
publication can set `publishOpenclawNpm=false`, `pluginPublishScope=selected`,
and explicit canonical package names in `plugins`.

Every fresh run requires an explicit `validation_purpose`. `publish` verifies
complete committed source metadata before projecting the requested publication
selection and before resolution can release any selected producer. Its retained
source-admission fact is **source-only**, not registry eligibility, product-test
success, or publication authority. `diagnostic`, `main-qualification`, and
`postpublish-confidence` omit `publication_selection_json` and record publication
source admission as not applicable. Coverage is selected independently.

Fresh publish requests also require tooling with registry admission. After
source verification, resolution collects bounded public npm and ClawHub
observations for the selected packages, uploads them, then binds the immutable
artifact and admission time before producers can start. Required read errors and
unsupported bootstrap states block admission; latest-dependency drift is advisory.
Supported first-package or trust-repair routes retain unresolved downstream owner
authority, not permission to publish. The source fact remains source-only.
Nonpublish requests do not collect registry observations.

The SHA-pinned helper packs its semantic `-f validation_purpose` and
`-f publication_selection_json` arguments into the existing
`trusted_workflow_json` input. Raw workflow dispatch uses this closed envelope:
`{"trustedWorkflow":{"ref":"main","fullRef":"refs/heads/main","sha":"<tooling-sha>"},"validationPurpose":"diagnostic","publicationSelection":null}`.
For the existing direct branch route, `trustedWorkflow:null` lets the identity
owner infer the executing identity; purpose is always explicit. Child workflows
still receive only the resolved identity tuple. Existing request artifacts reopen
without converting their inputs or witness digests.

`pnpm release:candidate` defaults to the normal publication route. Choose
`--publication-route prepared` before its first dispatch for the prepared button;
merely supplying a protected tooling ref does not select that route. Saved state
binds the choice and rejects contradictory resumes. Historical state without a
route retains normal recovery semantics and gains no source-admission claim.
For registry-admitted parents, the checklist reads authenticated retained planning
summaries instead of repeating the two local registry sweeps. Preparation and
publication compare that evidence with their actual selected operands; a normal
parent cannot authorize the prepared route by changing the command afterward.

Record the candidate SHA/ref and Tooling SHA/ref once for the release and reuse
them for later Code-SHA, Release-SHA, and focused reruns. Main lineage
authorizes the initial Tooling SHA selection; it does not authorize refreshing
the tooling from moving `main`.

## Exact frozen-target test omissions

Declare narrowly justified omissions before dispatch with JSON arrays of exact
repository-relative test paths. `plugin_prerelease_node_exclude_patterns_json`
applies to the Plugin Prerelease Node lane, for example
`["src/plugins/manifest-registry.test.ts"]`.
`extension_test_exclude_patterns_json` applies to the Plugin Prerelease extension
shards, for example
`["extensions/codex/src/app-server/run-attempt.test.ts"]`. Both default to `[]`;
there is no implicit Codex test omission. Normal CI keeps its own core lanes;
Plugin Prerelease owns the full extension sweep.

Pass them through the SHA-pinned helper as `-f name='["exact/path.test.ts"]'`.
The helper packs the extension input into the existing trusted dispatch envelope
to stay within GitHub's 25-input limit, and refuses tooling without the matching
lane-input capability before creating remote refs or dispatching.

Preflight rejects malformed, duplicate, nonexistent, and out-of-lane paths using
the selected target's actual Vitest discovery. Globs and basenames are not
accepted. Pinned tooling applies each exact omission to the executing config's
inline projects, preserves the candidate's normal test runner and setup, and
restores the original config bytes after the command. It does not depend on a
new exclusion environment variable being supported by the frozen candidate.

The immutable request, coverage identity, evidence reuse comparison, and final
manifest retain both input values. Changing them requires a new validation
request; continuation cannot widen an existing omission. Record the reason and
owning fix for each omitted test in release evidence. An omission is untested
coverage, not passing evidence.

## Retain and reconcile the root request

Before creating remote refs, the helper writes a private operator artifact at
`.artifacts/full-release-validation/<request-id>.json` and prints its path.
Use `--request-file <path>` to choose the artifact location. It retains the
repository, workflow, frozen target/tooling identities, transport refs, complete
typed/defaulted inputs, effective soak, and the first observed run and attempt.
The helper records attempted intent before its single workflow dispatch POST.

After a lost response or interruption, reuse that exact artifact:

```bash
node scripts/full-release-validation-at-sha.mjs \
  --reconcile-request .artifacts/full-release-validation/<request-id>.json
```

An existing `--request-file` also enters read-only reconciliation; conflicting
target, tooling, or input arguments are rejected. Recovery performs no ref
creation/deletion, dispatch, rerun, cancellation, Git fetch, or request rewrite.
`dispatch=observed` reports the exact run URL and attempt, not successful
validation. A newer attempt cannot replace the retained attempt.

Missing or ambiguous runs, incomplete pagination, unavailable or mismatched input
witnesses, and exhausted discovery remain `dispatch=unknown`. A complete HTTP
rejection is retained as `dispatch=rejected`; neither state permits redispatch.
Keep the artifact and printed refs for investigation. There is no automatic
retention expiry or cleanup for the local artifact; remove it only through
deliberate operator cleanup. Losing or deleting it never proves non-execution.
Independent requests and copies on other hosts are not globally deduplicated.

New requests require `FULL_RELEASE_SOURCE_ADMISSION_CONTRACT=1` and
`FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1` in the pinned
workflow. Older frozen tooling fails before remote creation instead of starting
work whose inputs cannot be proven. The helper never upgrades the Tooling SHA.
Use `frv status` for already-running frozen validations; choosing different
tooling for a new validation requires the release owner's explicit decision.
The workflow's separate input witness is attempt-bound and retained for seven
days. It reads the event file directly, without interpolating inputs into step
environment variables or logs. Only safe GitHub context and a SHA-256 digest are
uploaded: input keys sorted lexicographically, primitive values normalized to
wire strings, then JSON serialization. The immutable workflow SHA binds the
input types; the complete typed and wire maps remain in the private local
artifact. Runner or artifact-service failure can leave the witness unavailable;
it is never a release receipt or publication authority.

## Select coverage

`provider` also accepts `anthropic` or `minimax` for cross-OS onboarding and the
end-to-end agent turn. Regular `release/*` targets accept the branch's final
package version or a matching beta prerelease. For a correction, use
`--target-ref release/YYYY.M.PATCH-N` to preserve the intended final tag before
tagging. Its base package version is also accepted when `vYYYY.M.PATCH` resolves
to the exact Code SHA; preparation retains the package version and seals both
npm and Docker artifacts for `vYYYY.M.PATCH-N`. Tideclaw alpha validation uses
its exact alpha tag and matching alpha branch. The helper maps beta releases and
exact alpha tags to the `beta` profile and final versions to `stable`. Pass
alternate workflow inputs with `-f key=value`; use `-f release_profile=full`
only for the broad provider sweep.
`fail_fast` defaults to `false`, so dispatched child workflows finish and expose
independent failures together. In that mode, the parent makes no child
cancellation calls. Pass `-f fail_fast=true` only when the shorter
first-failure path is preferable; Release Decision then cancels only the exact
still-active child that owns the blocking failure.
Same-parent continuation requires the original root to have been dispatched
with `fail_fast=false`. The controller verifies that exact logged input before
any rerun mutation.
Current runs dispatch standalone `Full Release Artifacts` producers for npm,
Docker, and the validation candidate. Each producer owns its immutable dispatch
record and output receipt. Parent retries recover those exact producer IDs and
attempts, recheck their source and Tooling SHAs, and reuse the successful builds.
Historical parents that produced their own candidate or publication artifacts
cannot continue: keep both SHAs frozen and start a fresh all-group validation.

Automatic test retries are disabled. Dispatch rejects `known_flaky_jobs_json`;
remove that retired input and investigate the original job failure. Explicit
operator recovery remains available after diagnosis through
[continuation commands](/reference/full-release-validation/continuation).

After dispatch, the parent writes one immutable
`full-release-execution-plan-<run-id>` artifact and preserves the same bytes in
an exact run-ID Actions cache. It records selected and
required coverage, gate results, reuse identity, the original parent attempt,
the fresh candidate request plus producer and publisher evidence when preparation ran, and
every exact child run ID, attempt, title, workflow ref, and Tooling SHA.
Decision, Drain, manifest generation, evidence verification, and the final
verifier consume the artifact for their current attempt. After the original
guarded upload succeeds, the sealer records the plan digest in its job log.
Collector retries restore the exact run-ID cache before publication admission,
authenticate its bytes against that original upload and digest, and re-upload
the unchanged plan and admission for the current attempt. GitHub removes prior
parent artifacts on a full rerun, so retain the cache and original job logs.
If the cache is unavailable, an accessible plan artifact can supply the same
authenticated bytes. Missing or invalid evidence fails closed; retries never
rebuild the plan, recollect registry observations, or redispatch tests.
Release Decision also repeats canonical reuse-chain validation before a reused
run can pass. The sealed target SHA, evidence SHA, policy, changed-path set,
selected run, root run, source manifest, trusted tooling identity, and child
tuple must all still match.

On a parent retry, final verification selects the newest available Release
Decision and Diagnostic Drain artifacts independently. Both must bind the same
immutable plan and exact child tuple; their source attempts remain recorded in
the artifacts and may differ when only one collector needed a retry.
