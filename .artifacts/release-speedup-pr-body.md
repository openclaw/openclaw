## What Problem This Solves

Release validation should run independent work together and retain successful
child evidence even when the parent cannot seal its final manifest. The parallel
execution graph already existed; this branch protects it and adds independent
child receipt production and independent per-role reuse. Items 1–11 are implemented or verified locally; item 8 remains a separate implementation dependency. This adds trusted measured sharding, advisory publication policy, and sealed publication defaults. No 20-minute release timing has been measured.

## Summary

1. **Complete — parallel parent shape (`95c878a636fb`).** Added a dependency-graph
   guard in `test/scripts/full-release-validation-continuation-workflow.test.ts`.
   Source-only children start alongside npm/Docker producers after admission;
   candidate consumers depend directly on candidate verification, without
   waiting for npm qualification or independent validation. Documented the
   existing shape in `docs/reference/RELEASING.md`, `docs/ci.md`, and the
   `release-openclaw-ci` skill. Production orchestration is unchanged.
2. **Complete — independent child evidence (`bfe3853f2620`, `463212ca027f`).** Added
   `scripts/full-release-child-evidence.mjs`, the shared wire-budget owner
   `scripts/lib/full-release-evidence.mjs`, and
   `.github/workflows/full-release-child-evidence.yml`. CI, Plugin Prerelease,
   Release Checks, performance, and npm Telegram call the shared sealer for seven
   validation roles. Receipts bind target/workflow identity, normalized inputs,
   candidate descriptors, parent origin, publisher job, and attempt-composed
   workload results. Main ancestry and exact active attempt are checked.
   `scripts/full-release-validation-policy.mjs` keeps only the exact metadata
   publisher advisory, while workload failures remain governed by existing
   policy. Receipt-only retries retain prior workload evidence. The new
   `test/scripts/full-release-child-evidence.test.ts` exercises the actual CLI,
   workflow dependencies, provenance failures, retry composition, and metadata
   policy. The consumer adds bounded per-role receipt discovery, selective dispatch suppression,
   immutable plan hydration, decision revalidation, and final-verifier consumption.
   Failed/cancelled/active parents can supply verified green children; stale attempts,
   non-main-ancestor tooling, altered inputs/candidate bytes and invalid artifacts
   are rejected. Current-parent adoption witnesses bind the exact chosen receipts.
   Tests exercise discovery and the complete final verifier; docs match this behavior.
   Npm/candidate/Docker producers retain existing artifact receipts.
3. **Complete — trusted frozen-target planner (`1ac6fb6de54f`).** `.github/workflows/ci.yml`
   imports the Node planner and measured costs from pinned workflow tooling for
   frozen targets, retaining candidate cwd for discovery and execution. Sparse
   checkout carries the full native import closure, including normalization-core.
   Workflow ownership and real sparse-import regressions failed before the fixes.
   Updated historical fixtures and release/CI docs and skill guidance.
4. **Complete — generated hosted shard costs (`5688630584b3`).** Added `scripts/ci-shard-timings-refresh.mts` to measure exact completed release-CI hosted jobs and preserve retry/source identity. The existing timing store owns costs; the Node planner splits measured full-release rows at 720 seconds with complete selector generations, exact observed stripe costs, and indivisible-test rejection. Daily refit retains release measurements. Release docs and closeout skill require generator-owned updates. Fixture CLI and planner tests protect collection, unchanged output on provenance failures, coverage, rerouting, and budget enforcement.
5. **Complete — advisory publication policy (`6870369a4ddb`).** The shared validation policy makes non-proof CI/plugin/cross-OS/QA/performance results advisory by default, records them in summary evidence, and retains artifact, identity, install, survivor, first-hop, pack/npm and target-resolution proof. Aggregators follow required inputs. The prior explicit first-hop waiver remains survivor-conditioned. Publication preflight gates, core npm/stable closeout, and candidate validation no longer require performance. Tests cover default policy, all profiles/consumers, first-hop variants, summary rendering, and retained blocker/retry/provenance invariants.
6. **Complete — manifest-resolved publish inputs (`d57be0cc5f50`).** Added `scripts/lib/release-publish-inputs.mjs` and declarations. The all-group publication sealer in `full-release-validation-state.mjs` records the SDK evidence digest from the exact qualified npm artifact (evidence only; SDK API changes still require an operator-supplied acknowledgement at publication; the sealed soak waiver applies only while `OPENCLAW_RELEASE_STABLE_SOAK_WAIVER` still holds the same text, and publish children receive only the operator's explicit `stable_soak_waiver` while their own gates reread the variable), Main's #156811 blocking rewrite was not adopted on these surfaces (cross-OS coverage stays Linux-required, Windows/macOS advisory). resolves package decisions via the canonical npm plan owner, and captures `OPENCLAW_RELEASE_STABLE_SOAK_WAIVER`. Manifest normalization/reuse, publisher/preflight defaults, the existing npm state observer, and workflow forwarding consume those facts. Explicit overrides remain available; historical manifests keep their existing path. Publication mutation owners still verify live authority, immutable bytes and selectors. Tests cover SDK/identity/roster binding, plans and bootstrap, normalized overrides, native CLI output, and executable dispatch forwarding.
7. **Complete — existing candidate tag (`eb7f656f9a71`).** The candidate helper resolves remote lightweight and annotated tags against the exact target SHA; absent tags remain valid, conflicts and lookup errors fail closed. Updated release docs and CI skill. Real Git fixture covers all outcomes (483ms); 145 candidate cases passed (18.31s Vitest / 19.36s wrapper), changed checks and isolated P2 review passed.
8. **Verified — first-hop parallel lane dependency (`ef186819a0de`).** Remote `main` at `d51f3607b9789cb3d354ecce35fbced7485575e0` does not contain `bf7848ef23a7ec00a4c45aa39c0f8480b69274cf`, still advertised by `feat/first-hop-compat-parallel-lanes`. Read-only ancestry and source inspection confirm the work remains separate. No duplicate implementation or ref mutation.
9. **Complete — PR plugin coverage (`f3c4e8787a6f`).** The shared Node planner selects full `agentic-plugins` coverage for extension/plugin/manifest/catalog changes, including bundled metadata and category contracts. Precise selection appends the canonical owner and removes duplicate targets without triggering the 96-target fallback; compact fallback preserves partition, runtime and worker ownership. Superseded exact-file fallback removed; push exclusion retained. Updated Node routing docs and CI-limits skill.
10. **Complete — reserved validation runners (`55651979ae17`).** `OPENCLAW_RELEASE_RUNNER_GROUP` optionally routes 153 existing jobs across the 19-workflow validation graph. Default labels and caps remain exact; shared workers inherit an optional group through nested calls; mixed CI/performance reserve only for FRV dispatches. New evaluator-backed tests cover every runner, quoted group names, default routing, normal-run isolation, and nested propagation. CI/release docs and CI skill explain provisioning and capacity requirements. This scopes reservation to validation, not publication workflows.
11. **Complete — documentation synchronization (`6bfd215fad07`).** Reconciled `docs/reference/RELEASING.md`, `docs/ci.md`, both release skills, and linked regular-release/validation/handoff references. Removed contradictory blocking-test/performance rules, false flake heuristics and six-hour targets; preserved required publication proofs and separate native readiness. Docs inventory, changed check and fresh isolated P2 review passed.

The producer adds one best-effort hosted job per selected validation child,
up to seven per campaign, with no new Blacksmith registrations or ordinary
PR/main CI jobs. A shared sealer and existing attempt-composition owner keep
this new artifact responsibility in one place; the large policy file shrinks
rather than acquiring another serializer.

## Evidence

- `PATH=/bin:$PATH pnpm test test/scripts/full-release-validation-continuation-workflow.test.ts --maxWorkers=1`
  — item 1: 17/17 passed, Vitest 9.01 s, wrapper 10.70 s; new DAG assertion under 1 ms.
- `PATH=/bin:$PATH pnpm test test/scripts/full-release-child-evidence.test.ts test/scripts/full-release-validation-state.test.ts test/scripts/full-release-validation-continuation-workflow.test.ts --maxWorkers=1`
  — item 2: 364/364 passed, Vitest 33.29 s, wrapper 34.48 s. New receipt CLI file:
  18 tests, 10.552 s; existing state owner: 329 tests, 17.353 s. CLI fixtures
  verify the real producer boundary, including exact GitHub responses and artifacts.
- `PATH=/bin:$PATH pnpm test test/scripts/ci-workflow-guards.test.ts --maxWorkers=1 -t 'bounds matrix fan-out|pins every external GitHub Action|forbids moving reusable workflow'`
  — 3 relevant guards passed, 305 unselected; Vitest 1.32 s, wrapper 2.37 s.
- `PATH=/bin:$PATH pnpm check:workflows` — passed.
- `PATH=/bin:$PATH pnpm check:changed` — passed before each commit. The final
  item 2 check used a separate `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` to safely
  overlap focused tests. Types, line caps, formatting, dead exports, and lint passed.
- `git diff --check` — passed before each commit.
- Independent isolated Codex review through P2 — clean for both commits. Item 2
  initially found metadata-job failures affecting qualification and receipt-only
  retry gaps; both were fixed and the updated diff passed fresh review. The first
  item 2 test/check batches were stopped for those fixes and are not passing proof.
- No hosted workflow run, release, or publication was dispatched. Native artifact
  upload behavior, CI test seconds, and release wall-time improvement remain unmeasured.

- Resume verification: `PATH=/bin:$PATH pnpm check:changed` passed; the four touched
  consumer suites passed 596/596 (Vitest 69.76 s, wrapper 70.88 s), and fresh isolated
  review was clean through P2. The final-verifier file took 43.443 s because it
  exercises authenticated CLI/artifact boundaries in subprocesses; cheaper helper
  assertions would not protect those boundaries. The broad `pnpm test:changed`
  invocation was interrupted for scope/budget after expanding into unrelated
  workflow and Crabbox suites; it is not claimed as passing proof.

- Item 3: six focused CI guards passed (12.00s Vitest, 13.10s wrapper), 116 related
  planning cases passed (85.34s Vitest, 88.02s wrapper), changed checks and workflow
  validation passed, final root types/format/line caps passed, fresh review clean
  through P2. The new sparse-import test protects the actual native dependency
  boundary; existing planning cases exercise the shell workflow with fixtures.

- Item 4: `PATH=/bin:$PATH pnpm test test/scripts/ci-release-node-test-plan.test.ts test/scripts/ci-shard-timings-refresh.test.ts test/scripts/ci-test-timings.test.ts --maxWorkers=1` passed 185/185 (106.81s Vitest, 110.18s wrapper). New generator fixture file: 5.632s; new planner regression: 21ms. Existing timing suite exercises full CLI provenance, sampling and atomic output contracts, accounting for the longer run. `pnpm check:changed --staged`, docs inventory, diff check and fresh P2 review passed. Native hosted timing and CI seconds are not yet available.

- Item5: five touched suites validated 721 cases in combined retained proof. Final state + summary batch: 541 passes plus one obsolete rendering assertion; correcting that assertion passed its exact CLI regression (2.69s Vitest, 4.43s wrapper). New default-policy regression failed against pre-change source. Changed checks, workflow validation, diff check and fresh isolated P2 review passed. Initial failures were expected old policy fixtures and assertions; no flaky reruns or weakened proof contracts.

- Item6: `PATH=/bin:$PATH pnpm test test/scripts/release-publish-inputs.test.ts test/scripts/release-publish-gates.test.ts test/scripts/release-publish-state.test.ts --maxWorkers=1` — 48 passed, final 2.51s Vitest / 3.75s wrapper. New helper: 12 tests, ~4ms. Focused `package-acceptance-workflow.test.ts` sealed-input and artifact-owner dispatch cases — 4 passed, 557 unselected, 7.23s / 8.17s. `pnpm check:changed --staged`, workflow validation, final scripts/root types, diff check, and fresh isolated P2 review passed. Review found raw whitespace overrides displacing sealed defaults; fixed and regression-tested. Broad unrelated workflow simulations were interrupted and are not passing evidence.

- Item9: full two-file run covered 474 cases (462 passed, 12 obsolete policy expectations corrected), 164.07s Vitest / 165.15s wrapper. Final affected replay: 78 passed, 397 unselected, 54.31s / 56.05s; adds one push-scope case. Complete planner and fixture contracts account for suite cost; new precise cases ~0.7s total. Changed checks passed; final rerun reused unchanged successful dead-export proof. Fresh P2 review clean, diff check passed. No hosted CI seconds yet.

- Item10: 85 affected cases passed across five suites (7.36s Vitest / 11.61s wrapper); new routing suite 31 cases / 233ms. Workflow checks, root types, corrected lint, final changed gate, diff and fresh P2 review passed. Initial broad performance selection was interrupted, not passing proof. No native runner provisioning or wall-time measurement.

## Reconciliation with #156811 / #156934

Main landed two policy commits while this PR was in flight; both intents are kept (operator decision, Peter, 2026-09-23/24: fast stable path, flaky and non-proof lanes never block on their own).

- **Coverage (#156811, RomneyDa).** All-group validation must select every Gateway install/upgrade lane on Linux, Windows, and macOS (`hasRequiredCrossOsSuites`, nine pairs) plus the profile's Telegram, QA, plugin, and performance lanes; each lane runs once and first failures are preserved in the manifest, receipts, and summary. Linux Gateway cross-OS lanes join the required proof set and block; Windows/macOS variants and other non-proof lanes are recorded as advisory (`- Advisory:` decision entries, `::warning`). No lane he added is dropped; only their blocking classification differs from his commit.
- **Full stable validation (#156934, RomneyDa).** Stable tags default to `release_profile=stable` with soak and performance dispatched in parallel at `t=0`. His publisher gates are kept as the strict default: `stable-profile`, `soak`, and `performance` fail closed without waivers, and `pnpm release:candidate` rejects beta-profile stable candidates without an explicit waiver.
- **Operator fast path (Peter).** The `stable_soak_waiver` / `lane_waiver` plumbing is retained and is the only way to publish a stable without soak/performance evidence, from beta-profile evidence, or with failed non-proof lanes. Reasons must start with the target version; a sealed waiver takes effect only while the repository variable still holds it at publish time; waivers are recorded in the sealed manifest, Release Decision, publish receipt, GitHub release evidence, and closeout manifest, and surfaced as warnings.
- **Required in every mode.** Artifact children, install smoke, upgrade survivors, first-hop compat, pack budget/npm qualification, package integrity, `resolve_target`, Linux Gateway cross-OS lanes, and their Verify aggregators.
- **Planner (item 9).** Main's #156729 ("scope PR tests to affected consumers") already runs plugin coverage for plugin-relevant PR changes with precise retention; its planner and tests are adopted wholesale and the branch's earlier canonical-shard variant of item 9 is dropped as superseded; item 4's hosted-row timing split is re-applied on top of that planner.
- **Bootstrap authority.** The stable plugin-npm bootstrap approval records whether its soak waiver was explicit or sealed; a sealed waiver is honored at approval time, at the child's approval validation, and once more immediately before the token-backed `npm publish`, where the child fetches `OPENCLAW_RELEASE_STABLE_SOAK_WAIVER` live via `gh api` after identity verification (404 = revoked; any other read failure refuses the publish, so a job token without Variables read access fails loudly instead of publishing on unverified authority) and rejects a sealed waiver the variable no longer holds. Read-only preflight reports a sealed waiver as active only under the same condition.
- **Closeout replay.** `openclaw-stable-main-closeout.yml` gains `stable_soak_waiver` / `lane_waiver` dispatch inputs that fall back to the waivers sealed in the publish evidence, passes them (and the live repository variable) to its `stable-closeout` gate, and records them in the closeout manifest. This unblocks the 2026.9.6 closeout replay (run 35965160697 failed under #156934 with "does not record blocking product performance evidence" although the release was published under the operator soak waiver).

## Follow-ups

The first-hop parallel-lane branch must land separately; do not duplicate it. Item 2 is complete locally; hosted receipt
upload/reuse remains unmeasured.

The final full-branch changed check passed. The serial 20-file replay was stopped at the run budget after 1322.34 seconds, during unchanged frozen-admission stress fixtures; it is not a passing full-suite result. Two obsolete CI assertions were repaired: the final gate excludes its downstream receipt sealer, and cache-authority coverage leaves exact planner inventory to the executable sparse-import owner. Eight focused repaired/sibling cases passed (6.37s Vitest / 8.87s wrapper); 702 unrelated cases were unselected. Remaining broad package-acceptance coverage must finish before claiming a clean full replay. At that earlier checkpoint, no push, PR, fetch, rebase, branch switch, or origin/main mutation was performed.

## Release-day findings

- `plugin-npm-release.yml` readback pins `workflow.runAttempt` to the current attempt. A `gh run rerun --failed` recovery retains the successful pack job’s earlier artifact and therefore fails the workflow-tuple comparison. Producer-attempt-aware readback remains a follow-up.
- **Implemented:** the synchronous metadata and asynchronous jobs/log reads in `release-ci-summary.mjs`, used by full release evidence verification, now retry transient HTTP 5xx and network errors up to four total attempts with 2s/4s/8s backoff. This replaces the saved shell patch and covers the live failing attempt-jobs endpoint. Only narrowly recognized GET argument shapes retry; mutations, GraphQL, 4xx, and evidence rejection remain terminal. Other publisher shell reads and artifact-download policies are unchanged.
- Retry proof: the new sync/async regressions failed before the fix; the final three-suite run passed 295/295 (`pnpm test test/scripts/release-evidence-retry.test.ts test/scripts/release-ci-summary.test.ts test/scripts/validate-full-release-validation-evidence.test.ts --maxWorkers=1`), 61.44s Vitest / 63.13s wrapper. The 14 new cases took 9ms; the existing summary suite took 60.077s because it exercises CLI, artifact, and provenance boundaries that a helper test cannot replace. The consumer suite took 272ms. The initial async mock incorrectly omitted Node’s custom promisified output shape; it was corrected before the passing run. `PATH=/bin:$PATH pnpm check:changed --base HEAD`, formatting, and `git diff --check` passed; fresh isolated review is clean through P2. CI seconds and live release proof are not yet measured.

### Final branch verification

- `PATH=/bin:$PATH pnpm check:changed --base 3753440207a2` passed, including workflow validation, script/test-root types, formatting, lint and every dead-export scan.
- `PATH=/bin:$PATH pnpm test $(git diff --name-only 3753440207a2 HEAD -- 'test/scripts/*.test.ts') --maxWorkers=1` attempted all 20 touched suites. The interrupted replay retained 2,253 passing case lines and two deterministic stale assertions; these counts are partial, not a suite pass. The 256-group and oversized-record admission cases passed in 146.951s and 70.084s.
- `PATH=/bin:$PATH pnpm test test/scripts/ci-workflow-planning.test.ts test/scripts/ci-workflow-guards.test.ts test/scripts/full-release-child-evidence.test.ts --maxWorkers=1 -t 'emits one final CI gate|keeps manual candidates separate|imports the real frozen planner|waits for every workload job'` passed 8/8 selected cases after repair, including the actual sparse import and all receipt dependency contracts.
- The final follow-up changed check reuses the unchanged successful full dead-export proof; the repairs change test assertions only.
