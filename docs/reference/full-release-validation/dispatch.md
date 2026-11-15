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
can also be the **Release SHA**. Qualification defaults to Q=C;
select independently trusted P for admission, aggregate validation, and
publication, then run:

```bash
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  --request-file <private-request-file> \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

For `main`, `--admission-workflow-sha` is the reviewed ancestry anchor; the helper
may advance it to a verified descendant before dispatch as `main` moves. Add
`--pin-admission-workflow` only when the exact main SHA must remain unchanged.
Protected `release-publish/*` admission refs are always pinned.

This example selects normal final-release publication. Select `npmDistTag=beta`
for a beta, or `route=prepared` when the intended consumer is the prepared release
button. Core publication requires `all-publishable` plugins. Plugin-only normal
publication can set `publishOpenclawNpm=false`, `pluginPublishScope=selected`,
and explicit official package names in `plugins`.

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

Record C, Q, and P with the request. Q defaults to C. On the admitted candidate
route (`--trusted-workflow-ref candidate`), `--workflow-sha <Q>` may instead
select an exact reviewed main-ancestor Q. C owns source, package bytes, version,
and baselines; Q supplies the complete qualification workflow closure; P owns
admission, aggregate policy, verification, and publication. Invoking the helper
attests operator review of the exact C/Q tuple and coverage. P independently
authenticates that tuple, normalized inputs, and immutable Q transport before
dispatch. The helper never substitutes a moving main Q. Explicit
`--trusted-workflow-ref main` or protected-tooling routes remain separate
diagnostic, main-qualification, and postpublish-confidence routes; they cannot
supply fresh publication evidence.

## Recover qualification tooling without changing the candidate

Use this route for a diagnosed qualification/orchestration defect, not to hide a
product failure or clear an unexplained red job. A local controller update cannot
retrofit the workflow code of an already-dispatched parent.

1. Preserve the old request, C/Q/P identities, parent run and attempt, failed
   logs, and any successful child receipts. Reconcile uncertain writes first;
   settle any owned active tree before dispatching a replacement. Do not relabel
   the failed parent or edit its sealed plan, request, inputs, or admission.
2. Land and deploy the reviewed repair and the independent-Q admission support
   to the chosen P and Q revisions. Assess their exact full SHAs and required
   contracts before selecting them. Q must be a verified main ancestor and its
   complete workflow/reusable-workflow/action/script/planner/coverage closure
   must be reviewed. P must independently admit that exact C/Q tuple. The two
   revisions may be equal, but neither is inferred from moving main.
3. Keep C, its package version, source, release context, and intended baselines
   unchanged. Review and record the new request's complete effective inputs,
   including baseline values, coverage, publication selection, and soak. A new
   admission is not an edit to the old request. Use a new private request path.
4. Within the operator's explicit dispatch authorization, invoke the supported helper from the
   repaired trusted tooling checkout. Replace every placeholder with the
   assessed value; preserve the original intended publication selection and
   effective inputs rather than copying unrelated defaults:

```bash
CANDIDATE_SHA="<unchanged-full-candidate-sha>"
QUALIFICATION_SHA="<reviewed-full-main-ancestor-q-sha>"
PUBLISHER_SHA="<reviewed-full-main-p-sha>"
PUBLICATION_SELECTION='<original-reviewed-publication-selection-json>'
pnpm ci:full-release \
  --sha "$CANDIDATE_SHA" \
  --target-ref <original-canonical-release-context> \
  --trusted-workflow-ref candidate \
  --workflow-sha "$QUALIFICATION_SHA" \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  --pin-admission-workflow \
  --request-file <new-private-request-file> \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION" \
  -f rerun_group=all \
  -f fail_fast=false
```

The helper obtains new admission through P's existing
`openclaw-release-prepare.yml` operation and then creates the exact immutable
`release-ci/*` transport at Q. Do not create that ref or hand-assemble the
admission envelope. Use `--dry-run` to inspect the selected tuple before any
authorized dispatch; a preview is not hosted admission or success.

5. Record the new admission descriptor and parent run/attempt. Require a fresh
   successful parent and strict verification before publication. Whole-parent
   reuse keeps exact Q/P semantics. Individual child reuse across Q revisions
   requires authenticated identical workload closure and exact C, role,
   effective inputs, candidate descriptor, receipt, artifact, and live-attempt
   checks; it preserves the original producer Q. A plan-cache-only repair can
   be compatible, but a matching filename, green job, or fix SHA alone proves
   neither closure equivalence nor receipt eligibility. Missing evidence or
   changed workload closure requires fresh work, never relabeling.

### November 2026 plan-cache restoration incident

For release `2026.11.4`, the recorded frozen candidate is
`e283dccf68ba35ef1af5b3fa31571db7f4b6bc74` and the recorded P is
`292a425338aca4f447ff8f9983fc93a8fbb369d6`. FRV `43743742888`, attempt
`2`, failed plan-cache restoration. The hosted-controls fix is
`d7ee885db8f7b831761ef8be7676fc9d0b6e6ad6`. That fix identifier is not an
assessment of a deployable new P/Q pair or proof that any old child is reusable.
Keep the frozen C unchanged for this tooling-only recovery; deploy and assess
new P/Q containing the required repair/support, then follow the new-admission
procedure above. The failed FRV remains failed. This runbook does not authorize
or automatically dispatch a replacement or publish the release.

The captured source admission selected `npm-stable-v1`, stable/all-group
qualification with soak, primary baseline `openclaw@2026.11.3`, and survivor
baselines `2026.11.2`, `2026.11.3`, `2026.6.34`, and `2026.9.37`
(`all-scenarios` / `reported-issues`). Compare the replacement request against
these recorded selections. The helper owns baseline resolution; do not hand-edit
its reserved baseline envelope. Stop for review if newly resolved inputs differ
rather than silently treating them as the old qualification.

The November 15 investigation authenticated these retained child receipts with
the production verifier at their original Q=C and exact recorded inputs:

| Role                          | Run/attempt     | Receipt artifact ID |
| ----------------------------- | --------------- | ------------------- |
| Normal CI                     | `43719715726/1` | `14165507867`       |
| Independent plugin prerelease | `43719725775/1` | `14164184379`       |
| Candidate plugin prerelease   | `43747457564/1` | `14176495148`       |
| Candidate release checks      | `43747437691/1` | `14178081554`       |
| Independent release checks    | `43744253043/2` | `14177235935`       |

This is not cross-Q eligibility. A Q containing the independent-Q implementation
changes shared qualification scripts, so these five children must rerun under
the current conservative closure policy. Their original receipts stay valid
historical evidence; do not relabel them. A later parent-workflow-only change
can preserve eligible child evidence after the same strict verification.

The failed parent cannot supply successful whole-parent evidence or authorize
retained publication artifacts. Existing npm/Docker bytes and receipts remain
historical artifacts, not a qualified new-Q publication bundle. Reacquire and
qualify the selected artifact stages against unchanged C. Preserve the original
coverage, soak, platform requirements, and exact scope of any existing policy
grants; failed or missing required work must rerun. New P admission and a fresh
successful FRV with its immutable plan and final verification are mandatory.

## Exact frozen-target test omissions

Admitted candidate qualification, including independent Q, rejects test omissions.
The following inputs
apply only to explicit cross-revision diagnostics and retained historical
contracts; they do not authorize a narrower new publish request.

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
lane-input capability before creating the workflow ref or dispatching.

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

For new dispatches, including `--dry-run`, the helper first proves GitHub serves
the exact Validation SHA by bare-SHA fetch in a fresh temporary repository. A failed
fetch stops before any request artifact or remote mutation. The helper pushes one
immutable `release-ci/*` workflow ref at the exact Q only after independently
trusted P admits the frozen request, then dispatches C as `ref` and `expected_sha`.

Before creating that workflow ref, the helper writes a private operator artifact at
`.artifacts/full-release-validation/<request-id>.json` and prints its path.
Use `--request-file <path>` to choose the artifact location. It retains the
repository, workflow, frozen target/tooling identities, workflow transport ref, complete
typed/defaulted inputs, effective soak, and the first observed run and attempt.
The helper records attempted intent before its single workflow dispatch POST.

After a lost response or interruption, reuse that exact artifact:

```bash
node scripts/full-release-validation-at-sha.mjs \
  --reconcile-request .artifacts/full-release-validation/<request-id>.json
```

An existing `--request-file` also enters read-only reconciliation; conflicting
target, tooling, or input arguments are rejected. An explicitly selected
`--resume-request <file>` may continue an admitted candidate request only before
its qualification ref mutation or workflow POST. It retains the original tuple
and never repeats an uncertain write. Recovery performs no ref
creation/deletion, dispatch, rerun, cancellation, Git fetch, or request rewrite.
`dispatch=observed` reports the exact run URL and attempt, not successful
validation. A newer attempt cannot replace the retained attempt.

Requests written before the helper stopped creating `validation/target-*` refs
still record `targetRef` and `refs.target`, and the current helper rejects them
as invalid. Reconcile such a file with the helper from the parent of the merge
commit that removed the target ref, for example from
`git worktree add --detach <path> <merge-commit>^`. Neither version creates or
deletes refs during reconciliation. Keep any remaining `release-ci/*` or
`validation/target-*` ref while GitHub reruns or evidence diagnosis may still
need it, then delete it deliberately.

Missing or ambiguous runs, incomplete pagination, unavailable or mismatched input
witnesses, and exhausted discovery remain `dispatch=unknown`. A complete HTTP
rejection is retained as `dispatch=rejected`; neither state permits redispatch.
Keep the artifact and printed workflow ref for investigation. There is no automatic
retention expiry or cleanup for the local artifact; remove it only through
deliberate operator cleanup. Losing or deleting it never proves non-execution.
Independent requests and copies on other hosts are not globally deduplicated.

New candidate-owned requests require `FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT=1`,
`FULL_RELEASE_SOURCE_ADMISSION_CONTRACT=1`, and
`FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1` in Q. Older frozen tooling fails before remote creation instead of starting
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
npm and Docker artifacts for `vYYYY.M.PATCH-N`. The helper maps beta releases
to the `beta` profile and final versions to `stable`. Pass
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
authenticated bytes. Missing or invalid evidence blocks release approval; retries never
rebuild the plan, recollect registry observations, or redispatch tests.
Release Decision also repeats the shared reuse-chain validation before a reused
run can pass. The sealed target SHA, evidence SHA, policy, changed-path set,
selected run, root run, source manifest, trusted tooling identity, and child
tuple must all still match.

On a parent retry, final verification selects the newest available Release
Decision and Diagnostic Drain artifacts independently. Both must bind the same
immutable plan and exact child tuple; their source attempts remain recorded in
the artifacts and may differ when only one collector needed a retry.
