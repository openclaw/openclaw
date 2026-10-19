# Landing exceptions and recovery

- Read only for [native landing](landing.md) admin exception, uncertain intent, head replacement, lock recovery, or closeout. Same authority/guards; never new permission.

## Explicit prior-CI admin landing

- Prior successful run + reviewed conflict repair: explicit operator authorization required. Completed review + current `github_pending` prepared-head bindings stay intact. Ordinary landing authority alone insufficient.
- `node scripts/pr-lib/merge-prior-ci.mjs delta <prior-green-head> <prepared-head>` reports both heads, `deltaSha256`, `changedPaths`. Inspect delta; changed-check planner selects affected checks; record actual results.
- Evidence JSON: `version: 1`, `repository`, numeric `pr`, `head`, `priorHead`, numeric `runId`/`runAttempt`, `deltaSha256`, `changeKind: "conflict-resolution"`, operator `reason`, string `contracts`, `checks` with `command`, `result: "passed"`, `evidence` description. Scoped results = operator attestations, not current-head CI success.
- Verifier checks prior successful attempt's PR/head provenance + CI gate. PR run: matching association. Manual dispatch: current same-repository PR branch + ancestor tested head. Live writer needs repository + active organization-admin authority; only pending/skipped normal CI allowed. Failed required checks, security, enforced reviews, unresolved required threads still block.
- github.com immediate squash only; known ruleset policy, no classic protection, queue, auto-merge. Protected REST merge pins exact head; existing outcome retains run, delta, scoped proof, operator. Accepted/uncertain outcomes require reconciliation. Recovery only qualified cases below.
- Unknown GraphQL mergeability → complete REST observation retained for attempt. Preserve known GraphQL facts; read repo, PR head, main, rules, required checks together. Blocked CI remains blocked. Final REST reread → live authority/reviews/security/exact-CI verification. Missing/changed proof refuses before intent. No implicit admin route/mutation retry.

### Authorized pre-existing failures

- Land instruction covers inherited-only exception; readiness question, uncertain attribution, PR-caused failure do not. `github_pending`, `--admin-evidence`, `--confirmed-operator-admin`; preserve exact-head failed review + `tests.preExistingCi` (`head`, numeric `runId`/`runAttempt`, nonempty `reason`). Ordinary admission rejects; confirmed admin route verifies same head/failed attempt. Never waive product findings, enforced reviews, security.
- `pr-failure-report`/`openclaw/ci-gate` table against newest scheduled main: matching-signature **pre-existing** → cite run id + rows, no further attribution. Job-name-only **pre-existing** → compare failing tests with main first. **New**/**unknown** (different scope/no comparable main job) → PR's until disproven. Table changes evidence form, not authority/admission.
- Native version-1 schema still required: `changeKind: "pre-existing-failure"`; `priorHead` = recorded main baseline, `head` = prepared/tested PR head, `runId`/`runAttempt` = completed failed attempt. No prior success/conflict-resolution claim needed. Keep inspected `deltaSha256`, operator `reason`, affected `contracts`, actual passing scoped `checks`.
- `testedMerge`: inspected CI checkout, retained Git object with exactly two ordered parents (`priorHead`, `head`); tree = successful merge of parents. Baseline ancestor of captured protected main. Bind checkout attestation to artifacts; never omit PR changes.
- `artifacts`: named regular files with `name`, `path`, `sha256`. Reuse checkout/failure logs or table receipt; no new proof system. `checkout`: `reason` + `evidence` array of artifact names binding actual checkout.
- `failures`: exactly one per non-aggregate failed job: numeric `jobId`, observed `cases`, repo-relative `sourcePaths`, `reason`, `evidence` names. Verifier compares named baseline/tested-merge blob/tree objects. Matching-signature table row supplies attribution; no extra independent causal investigation. Native source checks remain; changed/unattributed inputs refuse admission. Job-name-only rows need test comparison first.
- `aggregate`: CI gate `jobId`, `causedBy` = all admitted failed-job IDs, `reason`, `evidence` names for downstream failure.
- Live verifier: run/attempt/PR/head identity, complete job accounting, current effective GitHub Actions gate check-run, source/artifact hashes. Other required checks + exactly one `security-fast` job must pass. New/running attempt invalidates prior attribution. Outcome/completion comment retain exception, never claim failed CI green.
- Fork run with empty PR association: match exact head, branch, source repo + check-run; other-PR association rejected. Outcome records source/check correlation, not API-provided association.

#### Delegated authority and policy reads

- Non-organization/repository admin writer: repository write, active org membership, live bypass for every effective CI gate ruleset. Native `current_user_can_bypass`: `always`/`pull_requests_only`. Qualifying ruleset: active, repository-owned branch rule, only GitHub Actions `openclaw/ci-gate` (integration `15368`). Mixed review/security rules, missing/changed policy, revoked/unavailable grants refuse.
- After CI/security inspection, verifier rereads policy/delegated authority; outcome retains writer, repo ID, ruleset IDs, bypass modes. No caller grant, permission mutation, or delegated prior-success conflict exception.
- GitHub administrators provision missing grants via ruleset owner; prefer dedicated CI-bypass team + pull-request-only mode. Inspect existing grants first. Never bot org-admin upgrade or broader review/security bypass. Operator invocation = task authorization; bypass grant = execution capability, not authenticated human approval.
- Authoritative classic-protection absence still required. Non-admin readable repo may return `404 Not Found`; GraphQL `branchProtectionRule: null`/empty `branchProtectionRules` can hide protection. Missing policy read → stop before intent, report capability. No writer upgrade, substituted credentials, caller-attested snapshot.

#### Main drift and security

- Active prior-CI admission permits unrelated forward main movement from both captured anchors with conflict-free, nonempty merge. Exact PR/policy + final authority checks remain; intent/landing-parent audit keep original main anchor.
- Selected REST: final observation + main materialization before final authority verification. GraphQL: post-authority local-only reread, including late REST fallback; newly unavailable main refuses pre-dispatch. Neither fetches after final authority.
- Crabbox admission checks forward main ancestry + candidate tree. Newer main in final proof → discard authority decision before materialization/settlement; repeat live verification within the same 15-minute, 32-round admin limit. Tested proof base pinned; live PR base forward ancestry checked; active org membership last live authority read.
- `OPENCLAW_PR_STRICT_DRIFT=1`: strict main stability every route. Retained-outcome reconciliation keeps strict main binding.
- Same-name Security Review commit status = separate gate. Bind successful protected-main publisher attempt + exact PR/head enforcement step; verify publisher checkout against current owner; read complete current statuses.
- Security owner interprets CI-only failure/success/waiting projection; current independent guard clearance when rollout applies, approval + PR/rollout identity revalidated. Historical green alone insufficient. Missing/stale/foreign/failed/changed clearance blocks. Only identified combined status may be excused with attributed Actions gate. Live facts, no operator security waiver; ordinary merge unchanged.

## Recovery and closeout

- Accepted/uncertain auto submission: retire retained request before remote-head replacement.

```bash
git rev-parse refs/openclaw/pr-merge-outcomes/<PR>
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --cancel-auto
```

- Exact non-queue auto intent supported even with lost submission response. Preserve intent, acknowledgment state, captures; check PR identity/head; reconcile concurrent merge. Matching active request cancelled once; already absent → record retirement without cancellation.
- Investigated operator recovery, not proof submission never executed. Lost cancellation response → observation-only retry, never blind second cancellation. Confirmed retirement required before head repair. Existing land authority covers recovery; no repeat ask/replacement PR merely for lost response.

### Receipt for an auto-merged pushed head

- GitHub merged collaborator-pushed head: inspect timeline + main history; explicitly select exact head.

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --merged-head <SHA>
```

- Requires current retained accepted non-queue auto intent, no cancellation record; MERGED PR retained identity/base + authoritative head; strict descent from prepared head; landed commit reachable from authoritative main, tree reconstructed under retained method. Squash receipt: one landed parent.
- CAS successor records `phase: merged`, `landed`, `headDrift {actor, outcome, mergedHead}`; preserves `head`, retains pushed head as parent. Never dispatch/cancel/re-arm/clear refs.
- Reject stale OIDs, identity/base/method drift, unselected/unrelated heads, OPEN/CLOSED PRs, unaccepted/cancelled intents, other routes, unreachable/mismatched receipts.
- `merge-run` can reconcile. Ownership-checked cleanup → new outcome OID with `scripts/pr merge-complete <PR> <OUTCOME_OID> --confirmed-operator-completion`. Comment names prepared + merged heads.

### Replacement after confirmed retirement

- Repair/push branch; refresh review/preparation; completed CI. Current retained OID + explicit reviewed head:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery --replacement-head <HEAD_SHA>
```

- Same authorized scope: fresh review/preparation, no renewed land permission. Exact SHA required; new scope/different merge method needs authorization.
- Ordinary replacement: completed gates, not `github_pending`; use [completed-evidence preparation](landing.md#review-prepare-merge). Confirmed-cancelled auto squash may use [prior-CI admin route](#explicit-prior-ci-admin-landing):

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --replacement-head <HEAD_SHA> --admin-evidence <path> --confirmed-operator-admin
```

- Fresh review + exact-head `github_pending`, live admin/review/security/CI evidence for selected head. Explicit `--replacement-head` may equal retained head; no synthetic commit needed, but selection mandatory. Old-head evidence cannot qualify another head/current attempt.
- Successor CAS keeps intent, confirmed cancellation, capture history; never relabel rejected/unsubmitted. Unconfirmed cancellation, renewed auto/queue request, missing explicit head, changed artifacts block. Queue cancellation unsupported.
- Failed operation lock: verify no owned child tools remain; exact emitted token/command only. Never hand-remove lock or competing retries. After throttling, inspect quota before native prepare/merge retry.
- Unaccepted prior-CI admin REST squash, same prepared head: recover only complete known response `Base branch was modified. Review and try the merge again.` + HTTP 405 + matching `gh` diagnostic. Inspect request/outcome; current admin evidence + existing confirmations:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --admin-evidence <path> --confirmed-operator-admin
```

- Records `recovery.providerRejection`; successor CAS retains qualified captures/prior intent; repeats current review/security/admin/evidence/head checks. Exact-head `github_pending` stays pending.
- Admission-mutated/extra captures, symlinks, other 405, timeouts, 5xx, mixed/truncated output block. Accepted/queue/Crabbox/replacement-head recovery excluded. Further explicit recovery needs new OID + independently qualified response; no automatic retry. PR merged meanwhile → reconcile, no new merge.
- Unaccepted uncertain prior-CI REST admin request: different current head fences exact `sha`. Fresh review + exact-head `github_pending` → ordinary current-head request:

```bash
scripts/pr merge-recover <PR> <OUTCOME_OID> --confirmed-operator-recovery \
  --replacement-head <HEAD_SHA> --auto-merge
```

- No `--admin-evidence`. Replacement must differ; PR OPEN; `MERGEABLE/BLOCKED` or `MERGEABLE/BEHIND` selects auto. `MERGEABLE/CLEAN` selects immediate only with passing current required checks and strict CLEAN final revalidation. Normal review/security/owner gates apply.
- CAS route `auto` or `immediate` + `recovery.staleHeadRetirement`; preserve ancestry + exact regular capture bytes, no interpretation; empty valid. Missing/symlink/extra/mutated captures, same-head/stale evidence, lifecycle/head drift, queue state, failed gates block.
- Two identical pre-dispatch failures without new evidence → stop same route. Inspect; choose already-authorized supported route with exact reviewed head, or report missing capability. Transport change never waives admission or permits accepted/uncertain replay.
- Failed/timed-out merge response may mean merged. Reconcile remote state + ancestry before retry. Verify commit on current main; draft/pending/local summary ≠ landed.
- Closeout only from persistent checkout after owning session exits/releases cwd. Child cwd change never moves parent agent/shell. Never remove any live-cwd worktree/subdirectory. Native cleanup refuses observed holders; never bypass with raw `git worktree remove`, `rm`, custom script. Own session holds cwd → report retained path, defer closeout.
- Outcome + verification complete → remove task-owned test logs, receipts, proof archives, scratch, `.crabbox` outputs, task archives under `.local`/temp. Published PR proof needs no local duplicate.
- Remaining finished worktrees: ownership/holder check + advertised native closeout. No archive/export/evidence handoff/replacement cleanup receipt required. Native finalized-task option for disposable-proof refusal only; preserve guard refusals.
- Preserve unrelated/unknown files, deliverables, explicit retention, unfinished source/necessary recovery state, active owners, credentials, agent state, shared dependencies. Never force removal, clear locks, sign off for another owner. Report `removed` only after path + registration absent; else path + exact blocker.
- Reconciled merge with completion pending: ownership cleanup first, then current receipt OID:

```bash
git rev-parse refs/openclaw/pr-merge-outcomes/<PR>
scripts/pr merge-complete <PR> <OUTCOME_OID> --confirmed-operator-completion
```

- Revalidates historical merge; native worktree, PR-owned local branches, remote head branch must be absent. Never merges/deletes resources. From `merged`, may post first completion comment; uncertain comment attempt → marker lookup only, never another POST. Missing/ambiguous marker stays pending; reread OID after every transition.
- First admin comment requires retained prior-CI evidence. Before cleanup requirement: verify landed historical parent against retained admission main. Comment labels audit reconstructed after merge, not original at-landing audit; preserve historical CI qualification, never claim current-head success. Other admin receipts need owner review of original audit/completion record.
- Final narrative: failure, owning repair, proof/limits, human credit, linked final state; material tradeoffs/uncertainty, no mandatory essay.
