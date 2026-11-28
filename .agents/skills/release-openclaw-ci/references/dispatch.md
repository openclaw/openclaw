# Release CI: dispatch

## Preflight

Run checks that execute candidate code in approved isolation, outside trusted admission/dispatch tooling.

**Before dispatch**

- Fresh validation through `pnpm ci:full-release` scans committed mock exports with trusted local tooling. Failure blocks dispatch for that candidate SHA. The helper does not run candidate code.
- When dispatching directly without the helper, run `pnpm check:test-mock-exports --base <frozen-sha>` in an approved isolated exact-candidate checkout with frozen dependencies. FRV repeats the guard before child fanout.
- `--skip-local-mock-preflight` logs the candidate SHA and defers only the local check to the hosted workflow. Build-only and retained requests are unchanged.

**Before full matrix dispatch**

- Run `pnpm ui:i18n:check` and `pnpm native:i18n:check` on frozen trusted target; bind both to exact SHA.
- Generated-locale drift warns; continue dispatch without requiring regeneration. Source edits/serialized refresh workflows can leave generated output temporarily behind.
- Normal CI retains strict `control-ui-i18n`/`native-i18n` jobs and actual summary results; selected failures block npm/ClawHub. PR/release-prep gates stay unchanged.
- Never execute arbitrary target checkout as helper code.

**Before expensive full validation**

- Run `pnpm ui:build` on that same target/frozen dependencies.
- Record SHA plus successful production build, precompressed-asset verification, startup/largest-asset budget results. Any failure blocks fanout.
- No dev-server substitute or budget increases.

For local full E2E, include private QA entries in the frozen, dependency-ready proof checkout's initial build:

```bash
OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build
```

Then use the selected E2E command's normal readiness checks. `scripts/lib/vitest-build-prerequisites.mts` requests private entries; `scripts/run-node.mts` otherwise triggers a full rebuild for `missing_private_qa_dist`. Scope the flag to this task-owned checkout/command. Release workflows/sealed artifacts still own publication package/image bytes.

Before full release validation:

```bash
gh api rate_limit --jq '.resources.core'
git status --short --branch
git rev-parse HEAD
```

## Dispatch

After source admission, plugin compatibility readiness, and reuse selection:

- Dispatch source-only children alongside npm/Docker artifact producers.
- Acquire candidates from raw npm bytes while qualification continues. Start candidate Plugin Prerelease/Release Checks immediately after candidate verification, without waiting for independent validation or Docker.
- Preserve immutable execution plan and final artifact qualification.

### Child receipts and reuse

Each selected child uploads trusted immutable `full-release-child-evidence-<target-sha>-<role>-<run-id>-<attempt>`. It retains normalized dispatch inputs/candidate descriptors, composes predecessor jobs across attempts, and excludes the running publisher from `workloadConclusion`. Collection failure loses reuse metadata, not workload qualification.

With `reuse_evidence=true`:

- Within **two minutes**, scan at most **100** recent runs, probe at most **40** target receipt inventories, and fully validate at most **five** matching receipts per role. Nonmatching inventories do not spend full-validation budget.
- Empty-string inputs equal absent inputs (GitHub omits them from `github.event.inputs`); nonempty defaults and candidate descriptor bytes match exactly.
- Raw successful children, or failed children accepted by current Q grants, may come from failed, cancelled, or active parents at the same Q or across Q. Independent Q requires authenticated tooling lineage; the original producer Q is not relabeled.
- Logs identify reuse, evaluated rejections, skipped runs, and fresh dispatches. Current-parent adoption witness/immutable plan bind each selection.
- Admitted P evaluates retained evidence using the candidate and pinned Q grants. A whole-child waiver does not require any run. Frozen Q still supplies dispatch inputs.
- Collectors/final verification recheck live attempt/conclusion, tooling lineage, inputs, artifact identity/digest/expiry, and successful trusted seal/upload. A newer attempt invalidates reuse; never rerun an adopted child to repair collection.
- Current-parent source/publication admission, successful-parent changelog reuse, and artifact producers' sealed receipts are unchanged.
- Cross-Q reuse retains original producer Q, exact C/role/effective inputs/defaults/candidate descriptor/receipt/artifact/live attempt. Green jobs alone do not establish eligibility. Set `reuse_evidence=false` when fresh execution under the new Q is required. Whole-parent authenticated reuse has a separate exact-Q contract with independently authenticated P. Never relabel failed FRV; eligible P-only repairs may use a separate [receipt-backed aggregate](recovery.md#receipt-backed-aggregate-recovery), otherwise qualify through a new successful parent.

### Optional beta performance

Optionally start standalone performance against frozen Code SHA in parallel:

```bash
# Optional beta confidence; stable/full qualification requires blocking performance.
fail_on_regression=false
gh workflow run openclaw-performance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_ref=<code-sha> \
  -f profile=release \
  -f repeat=3 \
  -f deep_profile=false \
  -f live_openai_candidate=false \
  -f fail_on_regression="$fail_on_regression"
```

- No separate mandatory prepublish wait for this beta signal. Compare available Kova, gateway-startup, and CLI-startup metrics with earlier release evidence/clawgrit before publish/closeout; record regressions and investigate product impact.
- Stable/full needs blocking performance, subject only to checked-in policy's exact Kova grants. Retain failed reports; record waived work separately from passing tests.
- `npm-beta-v1` defers performance. Every selected child still needs terminal evidence and proof of artifact-only publication.

### Admit and dispatch the exact tuple

Only the canonical helper performs lightweight `admit-qualification` on `openclaw-release-prepare.yml` at P, then dispatches FRV at Q. P records operator attestation, complete normalized inputs, and data-only frozen Q coverage; the immutable descriptor travels in the existing `trusted_workflow_json` envelope. Never execute candidate code in P admission or hand-assemble the envelope.

```bash
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --trusted-workflow-ref candidate \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  --request-file <private-request-file> \
  -f validation_purpose=publish \
  -f publication_selection_json="$PUBLICATION_SELECTION"
```

- Q defaults to C; candidate-route `--workflow-sha <Q>` selects assessed executable tooling or its authorized ledger-only descendant. C owns source, package bytes, version, baselines; Q owns complete qualification closure. P may use an existing protected `release-publish/*` tag at its exact SHA.
- Review candidate/coverage before dispatch: admission records operator attestation, not a bot exception. Scheduled main qualification explicitly uses `--trusted-workflow-ref main` and trusted-main semantics.
- Beta publication: `npmDistTag=beta`. Use `route=prepared` only for intended prepared-button consumers. Source admission neither qualifies registry state nor authorizes publishing.
- Purposes: nonpublish investigations `validation_purpose=diagnostic` with no publication selection; recurring main `main-qualification`; exact published-package confidence `postpublish-confidence`. Select coverage/profile independently.

### Request reconciliation

- Existing `--request-file` reconciles original route, Q/P, and inputs unchanged. `--reconcile-request <file>` is read-only; only `--resume-request <file>` continues after admission and before first FRV POST.
- If Q-ref creation succeeded but readback failed, resume verifies/reuses exact admitted Q ref and empty workflow inventory without another ref POST. Missing/moved refs or uncertain/nonempty inventories block.
- Read-only reconciliation verifies an uncertain prepared ref before suggesting resume; never rewrites/advances the request. Every resume revalidates authenticated admission/signer authority after recovery inventory reads, then checks ref immediately before dispatch.
- Stable/checklist wrappers relay verified helper recovery advice, never infer safety from raw uncertainty. Run offered explicit resume, then rerun wrapper. Attempted/uncertain FRV POST stays observation-only; never retry. Preserve original producer/current consumer identities in reuse.

### Routes and frozen context

- Regular `release/*` validation must include `target_context_ref` (helper `--target-ref`); never raw-dispatch without it. Canonical `release/*`/`extended-stable/*` workflow refs remain supported; Telegram must retain exact parent workflow ref/SHA through OIDC and attestation.
- Trusted-workflow release-branch CI passes `target_ref` + `release_candidate_ref`, never `release_gate` (requires workflow head == target). PR-head `ci.yml` fallback below is different and uses `release_gate=true`.
- A frozen Code SHA may precede an advanced canonical release branch only if still its ancestor and package version is the branch's final version or matching beta prerelease. Extended-stable branches/all tags require exact package-version match.
- Fresh qualification: Q=C or an assessed Q (including its authorized ledger-only descendant) through `--workflow-sha <Q>` on the candidate route; pass P separately. Missing contracts require deliberate Q repair/candidate backport, never main fallback. Tooling-only repair: [new admission](../../../../docs/reference/full-release-validation/dispatch.md#recover-qualification-tooling-without-changing-the-candidate), unchanged C/new request.
- Historical/cross-revision route: `--trusted-workflow-ref main --workflow-sha <recorded-main-tooling-sha>` (or protected tooling tag). New requests allow diagnostic, main-qualification, postpublish-confidence only—not publish qualification. Existing historical publish requests reopen before that restriction, keeping original trusted-main ancestry contract; they are not candidate-owned evidence. Never refresh recorded identities from moving main. Reuse stays enabled unless operator chooses `-f reuse_evidence=false`.
