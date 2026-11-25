---
doc-schema-version: 1
summary: "Dispatching Full Release Validation: Code SHA and Tooling SHA selection, helper inputs, and the immutable execution plan"
title: "Dispatch a validation run"
read_when:
  - Starting a Full Release Validation run
  - Selecting the Code SHA, Release SHA, and Tooling SHA
---

For [Full Release Validation](/reference/full-release-validation), freeze the
product-complete **Code SHA/ref** after release preparation:
refresh Control UI locales, enforce release CI's zero-fallback check, and prepare
the complete history manifest and substantive version-matched notes. Package
preflight requires a matching section, not a placeholder. Final notes let the
same commit serve as **Release SHA**.

Record preflight locale drift against frozen SHA; continue despite the warning.
Normal-CI `control-ui-i18n`/`native-i18n` failures still fail validation.
PR checks, preparation, and publication requirements are unchanged.

Linux (`ubuntu`), Windows, and macOS Gateway fresh-install/upgrade failures block
beta/stable/full Release Decision, npm publish, and `pnpm release:candidate`.
Retain selected lanes’ terminal evidence/actual conclusions in manifest/summary.
Normal CI, npm qualification, Docker, Package Acceptance, and profile
performance/soak gates remain.

Record all identities with the request:

| Identity | Ownership / selection                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C        | Source, package bytes, version, baselines.                                                                                                                                                  |
| Q        | Complete qualification workflow closure and grant ledger; defaults to C. `--workflow-sha <Q>` pins assessed executable tooling or its authorized ledger-only descendant, never moving main. |
| P        | Independently trusted admission, aggregate policy, verification, publication. Authenticates C/Q, normalized inputs, and immutable Q transport before dispatch.                              |

Invoking attests review of exact C/Q/coverage. `--trusted-workflow-ref main` and
protected-tooling routes supply diagnostic/main-qualification/postpublish-confidence
evidence only, never fresh publication evidence.

Before creating a fresh validation request, the helper scans mock factories and
the baseline from the committed candidate SHA using the installed tooling. It
does not check out the candidate or execute its code. A failure stops dispatch.
Use `--skip-local-mock-preflight` only to defer the local check to the hosted
workflow (for example, when diagnosing older tooling). The override logs the
candidate SHA and does not change the hosted guard or admission. Build-only
preparation and retained requests do not run this local scan.

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

- On `main`, `--admission-workflow-sha` is a reviewed ancestry anchor that may
  advance to a verified descendant. `--pin-admission-workflow` keeps it exact;
  protected `release-publish/*` admission refs are always pinned.
- The example selects normal final publication. Use `npmDistTag=beta` for beta,
  or `route=prepared` for the prepared release button. Core requires
  `all-publishable`; plugin-only normal publication may use
  `publishOpenclawNpm=false`, `pluginPublishScope=selected`, and explicit official
  package names in `plugins`.
- Every fresh run requires explicit `validation_purpose`. `publish` verifies
  complete committed source metadata before projecting selection or releasing
  producers. Source admission proves neither registry eligibility, test success,
  nor publication authority. `diagnostic`, `main-qualification`, and
  `postpublish-confidence` omit `publication_selection_json`, mark source admission
  not applicable, and collect no registry observations. Coverage is independent.
- Fresh publish tooling must support registry admission: after source verification,
  collect/upload bounded public npm/ClawHub observations and bind immutable artifact
  and admission time before producers start. Required read errors and unsupported
  bootstrap states block; latest-dependency drift is advisory. First-package/trust-repair
  routes leave downstream owner authority unresolved, not granted.

The helper packs `-f validation_purpose` and `-f publication_selection_json`
into `trusted_workflow_json`. Raw dispatch uses this closed envelope:
`{"trustedWorkflow":{"ref":"main","fullRef":"refs/heads/main","sha":"<tooling-sha>"},"validationPurpose":"diagnostic","publicationSelection":null}`.
The direct branch route uses `trustedWorkflow:null` to infer executing identity;
purpose stays explicit. Children receive only the resolved identity tuple.
Existing artifacts reopen without converting inputs or witness digests.

`pnpm release:candidate` defaults to normal. Select `--publication-route prepared`
before first dispatch; a protected tooling ref alone does not select it. Saved
state rejects contradictory resumes; historical routeless state retains normal
recovery without source admission. Registry-admitted parents supply authenticated
planning summaries instead of two local registry sweeps. Preparation/publication
compare actual operands: changing the command cannot turn normal admission into prepared.

## Check the hosted npm source and package build

An all-group Full Release Validation run already starts these checks in its
**Prepare npm artifacts** child. Follow that child when one exists. Its
`*-artifacts-npm-dispatch` artifact contains `dispatch.json`: match
`request.sourceSha` (C), `request.toolingSha` (Q), and the parent run/attempt
in `request.dispatchId`. Use the child run ID and attempt for the job lookup below.

Before FRV, a release owner can request the same hosted checks as a standalone
diagnostic. Select the frozen Code SHA and an existing protected
`release-publish/*` tag for the reviewed Tooling SHA. Regular beta and stable
all-group FRV use `beta` for this producer. For an extended-stable candidate,
use `extended-stable` and its canonical `extended-stable/YYYY.M.33` branch.
Source comes from C even when Q differs.

```bash
C="<full-code-sha>"
Q="<full-tooling-sha>"
Q_REF="release-publish/${Q:0:12}-<decimal-id>"
DIST_TAG=beta
RELEASE_CANDIDATE_BRANCH=""
REPO=repos/openclaw/openclaw

[[ "$C" =~ ^[0-9a-f]{40}$ && "$Q" =~ ^[0-9a-f]{40}$ &&
   "$Q_REF" =~ ^release-publish/${Q:0:12}-[1-9][0-9]*$ &&
   "$(gh api "$REPO/git/ref/tags/$Q_REF" --jq .object.sha)" == "$Q" ]] || {
  echo "Check the full Code SHA, Tooling SHA, and protected tooling tag." >&2
  exit 1
}
gh api --method POST -H "X-GitHub-Api-Version: 2026-03-10" \
  "$REPO/actions/workflows/openclaw-npm-release.yml/dispatches" \
  -f "ref=$Q_REF" -f "inputs[tag]=$C" -F 'inputs[preflight_only]=true' \
  -f "inputs[npm_dist_tag]=$DIST_TAG" \
  -f "inputs[release_candidate_branch]=$RELEASE_CANDIDATE_BRANCH" \
  --jq '{run: .workflow_run_id, url: .html_url}'
```

Record the returned run ID. If the dispatch response is lost, locate the run
in Actions before retrying. Inspect the exact attempt (initially `1`):

```bash
RUN="<npm-producer-run-id>"
ATTEMPT=1
API="repos/openclaw/openclaw/actions/runs/$RUN/attempts/$ATTEMPT"
gh api "$API" --jq '{path, event, display_title, head_branch, head_sha, run_attempt, status, conclusion,
  preflight: [.referenced_workflows[]? | select(.path | contains("/openclaw-npm-preflight.yml@"))]}'
gh api --paginate "$API/jobs?per_page=100" --jq '
  .jobs[] | select(.name | endswith(" / Check npm release source") or
                          endswith(" / Prepare publishable npm package")) |
  [.name, .run_attempt, .head_sha, .status, .conclusion, .html_url] | @tsv'
```

For standalone, match `openclaw-npm-release.yml`, the `[C] preflight parent=manual/1`
title, and Q's ref and SHA. For FRV, match `full-release-artifacts.yml` and the
admitted child. Both callers must show OpenClaw's reusable `openclaw-npm-preflight.yml`
at Q. Record hosted source and package build success once **both** jobs show the
expected attempt, Q, and `completed / success`.
With older candidates, the current workflow runs the full source check in
`guards` when the target lacks stage or lint-shard selection. Use the aggregate
source result. Record a failed job with its URL and leave missing or unfinished
proof unverified.

SDK, dependency, and package-content checks can still be running at that point.
Full npm qualification ends at **Qualify prepared npm package**. A standalone
diagnostic supplies a fix handoff. Each FRV request applies its own admission
and [evidence reuse rules](/reference/full-release-validation/stages).

## Recover qualification tooling without changing the candidate

Use executable tooling recovery only for diagnosed qualification/orchestration
defects—not product failures or unexplained red jobs. Local controller updates
cannot retrofit frozen workflows. For an explicitly authorized waiver,
use the [Q-only ledger procedure](/reference/full-release-validation/evidence#release-tooling-waivers):
commit directly to Q without a grant PR to `main` or a C change, then use a fresh
request/admission with that exact Q. Its ledger-only delta permits eligible raw
receipt reuse and reevaluation, not reuse of an earlier aggregate verdict.

1. Preserve old request, C/Q/P, parent run/attempt, failed logs, and successful
   receipts. Reconcile uncertain writes and settle owned active trees before
   replacement. Never relabel the failed parent or edit sealed plan/request/inputs/admission.
2. Land/deploy reviewed repair and independent-Q support to assessed full P/Q
   SHAs. Review Q's complete workflow/reusable-workflow/action/script/planner/coverage
   closure; verify main ancestry. P must independently admit exact C/Q.
   P and Q may match; neither comes from moving main.
3. Keep C, version, source, release context, and intended baselines unchanged.
   Review/record all effective inputs, including baseline values, coverage,
   publication selection, and soak. Use a new private request path/admission.
4. Within explicit operator dispatch authorization, run from repaired trusted
   tooling. Replace placeholders with assessed values; preserve original
   selection/inputs, not unrelated defaults:

```bash
CANDIDATE_SHA="<unchanged-full-candidate-sha>"
QUALIFICATION_SHA="<reviewed-full-q-sha>"
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

For an explicitly selected historical qualification, add both inputs before the
new request is admitted:

- `-f qualification_baselines_json='<original-baseline-object>'` selects exact
  published stable predecessors, validated against C and the release context.
  Without this input, a fresh request resolves the current baseline policy.
- `-f publication_artifact_source_json='{"runId":"<original-parent>","runAttempt":1}'`
  selects original publication artifacts independently of the parent verdict.
  It requires candidate admission, `rerun_group=all`, and `reuse_evidence=true`.
  The original source admission, sealed candidate, producer receipts, and exact
  package digest must agree. Missing or changed evidence fails closed instead
  of rebuilding different bytes. Cross-Q selection retains the original tooling identity; workload evidence
  is authenticated separately.

Both selections are frozen in P admission and the execution plan. Resume keeps
them unchanged even when npm advances. The new parent must pass its own gates;
selecting a failed historical parent never adopts its aggregate verdict.

The helper obtains P admission through `openclaw-release-prepare.yml`, then
creates immutable `release-ci/*` at Q. Never create it or assemble admission
manually. `--dry-run` previews the tuple, not hosted admission or success.

5. Record new admission and parent run/attempt; require fresh parent success and
   strict verification before publication. Whole-parent reuse keeps exact Q/P.
   [Cross-Q child reuse](/reference/full-release-validation/stages) keeps exact C,
   role, effective inputs, candidate descriptor, receipt, artifact, live attempt,
   and authenticated producer Q. Current Q grants are reevaluated. Tooling and
   harness changes do not force reruns; set `reuse_evidence=false` to execute the
   new harness. Missing or invalid evidence requires fresh work, never relabeling.

### November 2026 plan-cache restoration incident

| Recorded fact                 | Value                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Release / frozen C            | `2026.11.4` / `e283dccf68ba35ef1af5b3fa31571db7f4b6bc74`                                |
| P                             | `292a425338aca4f447ff8f9983fc93a8fbb369d6`                                              |
| Failed plan-cache restoration | FRV `43743742888`, attempt `2`                                                          |
| Hosted-controls fix           | `d7ee885db8f7b831761ef8be7676fc9d0b6e6ad6`                                              |
| Source admission              | `npm-stable-v1`; stable/all-group with soak                                             |
| Primary baseline              | `openclaw@2026.11.3`                                                                    |
| Survivors                     | `2026.11.2`, `2026.11.3`, `2026.6.34`, `2026.9.37`; `all-scenarios` / `reported-issues` |

The fix proves neither deployable P/Q nor child eligibility. Keep C frozen;
assess/deploy repaired P/Q and follow new admission. The failed FRV stays failed;
this runbook authorizes no dispatch/publication. Compare resolved inputs with
these selections; never hand-edit the helper-owned reserved baseline envelope.
Stop for review on differences.

The November 15 production-verifier investigation authenticated these receipts
at original Q=C and exact recorded inputs:

| Role                          | Run/attempt     | Receipt artifact ID |
| ----------------------------- | --------------- | ------------------- |
| Normal CI                     | `43719715726/1` | `14165507867`       |
| Independent plugin prerelease | `43719725775/1` | `14164184379`       |
| Candidate plugin prerelease   | `43747457564/1` | `14176495148`       |
| Candidate release checks      | `43747437691/1` | `14178081554`       |
| Independent release checks    | `43744253043/2` | `14177235935`       |

At the time, all five needed reruns under the former cross-Q closure rule.
Under the current rule, assess each receipt against the new parent and reuse only
if strict verification accepts it. Existing npm/Docker bytes/receipts are not a
qualified new-Q bundle. Reacquire/qualify selected stages against unchanged C; preserve coverage,
soak, platforms, and exact policy-grant scope. Rerun missing/failed required work.
New P admission, successful FRV, immutable plan, and final verification are mandatory.

Admitted independent Q yields candidate-sealed C/Q evidence; the separate
cross-revision diagnostic route cannot substitute. After success, consume with
`pnpm release:candidate -- --full-release-validation-run-id <run> --skip-dispatch`
and original candidate/tag, publication scope, and pinned P options. Fresh
checklist qualification defaults Q=C; its `--workflow-sha` selects P, not Q.

## Exact frozen-target test omissions

Candidate qualification (including independent Q) rejects omissions. Only explicit
cross-revision diagnostics/retained historical contracts accept these JSON arrays
of exact repository-relative paths—not new publish requests:

| Input                                          | Lane / exact-path example                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `plugin_prerelease_node_exclude_patterns_json` | Plugin Prerelease Node: `["src/plugins/manifest-registry.test.ts"]`                           |
| `extension_test_exclude_patterns_json`         | Plugin Prerelease extension shards: `["extensions/codex/src/app-server/run-attempt.test.ts"]` |

Both default to `[]`; no implicit Codex omission. Normal CI owns core lanes;
Plugin Prerelease owns the full extension sweep. Declare narrow justification
before dispatch with `-f name='["exact/path.test.ts"]'`. The helper packs the
extension input into the trusted envelope for GitHub's 25-input limit; unsupported
lane-input tooling fails before ref creation/dispatch.

Preflight uses target Vitest discovery; malformed, duplicate, nonexistent,
out-of-lane paths, globs, and basenames fail. Pinned tooling applies exact omissions
to inline projects, preserves candidate runner/setup, and restores config bytes—no
new candidate exclusion environment variable required. Both values remain in
request, coverage identity, reuse comparison, and manifest. Changes require a
new request; continuation cannot widen omissions. Record each reason/owning fix:
omitted means untested, not passed.

## Retain and reconcile the root request

Even `--dry-run` first bare-SHA-fetches exact Validation SHA in a fresh temporary
repository; failure precedes artifacts/mutations. After P admits the frozen
request, the helper pushes one immutable `release-ci/*` ref at Q and dispatches
C as `ref` and `expected_sha`.

Before ref creation, private `.artifacts/full-release-validation/<request-id>.json`
(override: `--request-file <path>`) records repository/workflow, target/tooling,
transport ref, complete typed/defaulted inputs, effective soak, and first observed
run/attempt. The helper prints its path and records intent before its single POST.

After interruption or lost response, reuse that artifact:

```bash
node scripts/full-release-validation-at-sha.mjs \
  --reconcile-request .artifacts/full-release-validation/<request-id>.json
```

| Recovery mode                      | Contract                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing `--request-file`          | Read-only reconciliation; conflicting target/tooling/inputs rejected. No ref creation/deletion, dispatch, rerun, cancellation, Git fetch, or request rewrite.                                                                                                                                                                                                             |
| Explicit `--resume-request <file>` | Admitted candidate only, before first qualification POST. After uncertain ref readback, verify admitted Q and empty exact workflow inventory; reuse without another ref POST. Revalidate admission/current signer authority after inventory reads, then reread ref immediately before intent/dispatch. Missing/moved ref, uncertain inventory, or any run refuses resume. |
| Attempted POST                     | Observation-only; never repeat. Reconciliation verifies uncertain prepared refs before suggesting resume. Wrappers relay helper advice: run offered explicit resume, then rerun wrapper; raw prepared/uncertain state is insufficient.                                                                                                                                    |
| `dispatch=observed`                | Exact URL and retained attempt, not success; newer attempts cannot replace it.                                                                                                                                                                                                                                                                                            |
| `dispatch=unknown`                 | Missing/ambiguous runs, incomplete pagination, unavailable/mismatched witnesses, or exhausted discovery. No redispatch.                                                                                                                                                                                                                                                   |
| `dispatch=rejected`                | Complete HTTP rejection. No redispatch.                                                                                                                                                                                                                                                                                                                                   |

Retain artifact/ref for investigation. Local artifacts have no automatic expiry
or cleanup; deliberate deletion never proves non-execution. Independent requests
and cross-host copies are not globally deduplicated.

Legacy files containing `targetRef`/`refs.target` from `validation/target-*` are
rejected by current tooling. Reconcile with the helper before its removal merge,
for example `git worktree add --detach <path> <merge-commit>^`. Neither helper
mutates refs during reconciliation. Keep `release-ci/*`/`validation/target-*`
while reruns/diagnosis need them; delete deliberately afterward.

Candidate Q requires `FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT=1`,
`FULL_RELEASE_SOURCE_ADMISSION_CONTRACT=1`, and
`FULL_RELEASE_DISPATCH_WITNESS_CONTRACT=1`; older tooling fails before remote
creation, never auto-upgrades. Use `frv status` for running frozen validations;
new tooling requires the release owner's explicit decision.

The separate attempt-bound input witness lasts seven days. It reads the event
file directly, without input interpolation into step environment/logs; uploads
only safe GitHub context and SHA-256 of lexicographically sorted keys,
primitive wire-string normalization, and JSON serialization. Workflow SHA binds
types; complete typed/wire maps stay private locally. Runner/artifact failure may
make the witness unavailable; it is neither receipt nor publication authority.

## Select coverage

- `provider` also accepts `anthropic`/`minimax` for cross-OS onboarding and the
  end-to-end turn. Regular `release/*` accepts final package version or matching
  beta. Corrections use `--target-ref release/YYYY.M.PATCH-N` to retain the final
  tag; base version is accepted if `vYYYY.M.PATCH` resolves to exact C.
  Preparation keeps package version and seals npm/Docker for `vYYYY.M.PATCH-N`.
- Beta maps to `beta`, final to `stable`. Override inputs with `-f key=value`;
  `-f release_profile=full` is only for the broad provider sweep.
- `fail_fast=false` (default) lets children finish without parent cancellation.
  `-f fail_fast=true` selects first-failure handling: Release Decision cancels
  only the exact active child owning the blocker. Same-parent continuation
  requires logged original `fail_fast=false`, checked before rerun mutation.
- Standalone `Full Release Artifacts` producers own npm/Docker/candidate immutable
  dispatch records/receipts. Parent retries recover exact IDs/attempts, verify
  source/tooling SHAs, and reuse successful builds. Historical parent-owned
  artifacts cannot continue: freeze both SHAs and start fresh all-group validation.
- Automatic retries are disabled. Remove rejected `known_flaky_jobs_json`,
  diagnose failure, then use [operator continuation](/reference/full-release-validation/continuation).

The immutable `full-release-execution-plan-<run-id>` artifact and identical
run-ID Actions cache record coverage/requirements, gates, reuse identity,
original parent attempt, fresh candidate request and preparation's producer/publisher
evidence, plus exact child IDs/attempts/titles/refs/tooling SHAs. Decision, Drain,
manifest generation, evidence verification, and final verifier consume the
current-attempt artifact. After guarded upload, the sealer logs its digest.

Collector retries restore/authenticate original bytes from cache (or accessible
plan artifact) before publication admission, then upload unchanged plan/admission
for the current attempt. Retain cache/original logs: full reruns remove prior
artifacts. Missing/invalid evidence blocks approval; retries never rebuild plans,
refresh registry observations, or redispatch tests. Release Decision rechecks the
reuse chain: target/evidence SHAs, policy, changed paths, selected/root runs,
source manifest, trusted tooling, and child tuple must match.

Final verification independently chooses newest available Decision/Drain artifacts;
both bind the same plan/child tuple, retaining possibly different source attempts.

### Historical artifact and workload identity

Historical selection preserves the producer's original Q and verifies the
original admission, plan, exact producer attempts, and package/image receipts.
It does not relabel the publication bytes or inherit a prior aggregate verdict.
Child-workload reuse is a separate decision: authenticate the producer tooling
lineage, exact candidate and effective inputs, and live attempts, and apply the
current admitted waiver policy. Set `reuse_evidence=false` to require fresh
execution instead of selecting a historical publication source.
