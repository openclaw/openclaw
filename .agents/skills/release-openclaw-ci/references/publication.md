# Release CI: publication

## Fast-track approval boundary

The sole approval gate is the normal GitHub Actions `npm-release` environment,
reviewed by an eligible npm release manager. No Firebase service, chat/group
approval, approval URL or manually supplied approver/time is required. Agents
must not approve the environment using a human's token. Preparation and scoped
dispatch do not require a separate chat decision.

Pass exception evidence with `--fast-track-request <packet.json>` to
`pnpm release:publish-preflight`, forwarded as `fast_track_request`. Preserve
original FRV results and sealed bytes. Bounded policy: 20 commits AND 15,000
added/deleted lines, excluding enumerated package manifests/lockfiles from LOC
only; beta prereleases have no ceiling or reference release, and their stable
promotion still needs a passing stable FRV. Partial-FRV retains a complete outstanding-check snapshot without a delta
ceiling. Neither establishes a fully validated baseline. Post-expiry recovery
uses the original packet-bound GitHub publication receipt and verified job start
time. See the [release skill](../../release-openclaw-maintainer/SKILL.md#fast-track-publication-uses-github-approval).

### Before publication

- Regular beta/stable protected publication: after evidence validation, run `pnpm release:publish-preflight` with intended tag, exact FRV run/attempt, npm dist-tag, plugin scope, and protected tooling ref. `pnpm release:candidate` supplies its downloaded manifests; do not redownload or replace the attempt. Resolve every `FAIL` and owner-action `WARN` before using the report's exact route-specific dispatch command. Extended-stable has separate owner workflows, outside this preflight; alpha is retired.
- Checklist `--workflow-ref`/`--workflow-sha` selects P, not candidate harness. Reuse authenticated stable Telegram proof from the exact qualified tarball; beta remains deferred. Supplemental Telegram requires the retained qualification ref verified at admitted Q, harness pinned to Q, and package source pinned to C—never moving main. Parallels uses isolated Q checkout/dependencies against exact C tarballs. Supplemental Telegram run IDs belong in candidate evidence, not the optional publisher diagnostic input.
- Before retrying publication, inspect the report: preserve verified `openclaw_npm_resume_run_id` for published core bytes; inspect matching draft/published release; identify exact orphan plugin/ClawHub children before cancellation.
- Preflight is read-only: no publish/cancel authority and no proof of repository secrets from local credentials.
- Bootstrap candidates need the release credential owner to confirm `NPM_TOKEN` readiness; follow [bootstrap credential readiness](../../release-openclaw-maintainer/references/publication-recovery.md#check-the-bootstrap-token). Do not publish or rotate credentials during preflight.

### Release notes and publication bytes

- Notes committed before fresh full qualification: retain Code SHA as Release SHA, same successful parent/attempt, exact prepared bytes for candidate/publication checks. Required gates/final channel-specific SDK review still apply. Publishers consume sealed acknowledgement; candidate helper retains explicit argument when needed.
- Notes changed afterward: commit selected entry/permitted record/index updates; optionally run helper with reuse on new Release SHA. Require `policy=split-changelog-release-v1`, `evidenceSha=<code-sha>`, complete `changedPaths`:
  - Required `CHANGELOG/YYYY.M.PATCH.md`; optional `CHANGELOG.md` and `CHANGELOG/records/YYYY.M.PATCH.md` only.
  - Entry/record additions or modifications; index modifications only. Renames, deletions, other releases, or docs-source edits require fresh product qualification.
  - Historical root-only receipts retain `changelog-only-release-v1`. Reuse product matrix rather than dispatch child lanes; npm preflight/package/install acceptance still test exact Release SHA/new tarballs.
- Current all-group FRV also owns read-only core and selected-plugin npm source/build/qualification and Docker preparation. Use successful run as `preflight_run_id` (candidate helper default); no second npm preflight except historical separate-evidence recovery.
- Regular final qualification records SDK reports for `beta` and `latest`; review actual channel acknowledgement. Prepared descriptors live in `publicationArtifacts`. Release Prepare adopts the manifest's plugin npm descriptor and prepares only ClawHub; it never repacks plugin npm after FRV. Reusing product evidence never substitutes Code-SHA packages/images for Release-SHA bytes.
- Failed independent npm qualification: `pnpm frv continue --failed` retries failed npm jobs on original run, carries successful preparation/diagnostic children, and verifies receipts in parent. Failure alone does not reject continuation. Frozen workflows retain original receipt logic; local controller upgrades do not retrofit it. Final verification owns recovery result.
- SHA-pinned helper infers beta for matching beta candidates, stable for stable/correction versions, and passes C/Q/P. Canonical beta `all` without soak uses `npm-beta-v1`; main/non-beta targets cannot. Run deferred native, performance, Telegram, broad live QA/E2E postpublish against exact package with `run_release_soak=true` or explicit groups. Stable/full force soak. Native publication retains build/signing/notarization/promotion gates. After focused fixes use a narrow `rerun_group`, never automatic widening.
- At seal, parent records SDK evidence digest from qualified npm receipt and resolves per-package npm plans against registry. Manifest `publishInputs` supplies publisher/preflight defaults. SDK API changes still need acknowledgement: the release agent reviews and acknowledges them, stopping for the operator only if a change looks harmful. Evidence grants no authority. Mutation owners recheck live authority, selectors, immutable bytes.

### Publication requirements

- Publish with `release_profile=from-validation` (sealed profile). Ordinary publication requires successful FRV; stable needs stable/full evidence, soak and blocking performance. An exact approved fast-track packet may accept validation gaps, never missing or mismatched sealed artifacts, signing, source admission or publication authority.
- Decide blocker/flake for every failed test. Same-Release-SHA flakes: at most two reruns plus main fix-in-parallel issue/PR, never flake-only re-cut.
- A reviewed [release-tooling waiver](../../../../docs/reference/full-release-validation/evidence.md#release-tooling-waivers) removes the obligation to run the named job. A `step` selector only matches the first incomplete or failed step of that job. Omit `jobName` to waive the whole child role and its descendants: do not dispatch, look up, or reuse that child. Keep raw outcomes. Land/pin P, then run/revalidate FRV without changing C/Q. Publisher cannot grant ad hoc waivers. Without an exact approved fast-track packet, failed FRV, unwaived missing/skipped/cancelled/unknown required coverage and invalid required evidence block. Approval accepts the recorded validation gap; the original FRV stays failed or incomplete. See [#204382](https://github.com/openclaw/openclaw/pull/204382) and [the Performance cancellation](https://github.com/openclaw/openclaw/actions/runs/45327586533) that blocked [FRV 45326913251](https://github.com/openclaw/openclaw/actions/runs/45326913251).

### Publish children

Use [publication recovery](../../release-openclaw-maintainer/references/publication-recovery.md) for ordering and prepared/direct recovery.

- One `pnpm release:watch --run <parent>` per publish parent ([contract](../../../../docs/reference/RELEASING.md#watch-publication)); no custom monitor. Reports parent/child environment gates, failed runs, failed `continue-on-error` jobs; backs off on rate limits.
- `pnpm release:stable <version>` ([orchestrated stable release](../../release-openclaw-maintainer/references/regular-release.md#orchestrated-stable-release)) dispatches parent once, approves parent `npm-release`, prints child approvals only for older tooling without `npm-publish` and stale-child sweeps when needed; never mutates child runs. Every refusal prints exact recovery command under `Next:`.

#### Approval receipts

- Parent `npm-release` approval mints attested `openclaw-release-approval-v1-<parent run>-<attempt>`. Bot children verify via `scripts/release-approval-receipt.mjs verify` before gates: one human approval per release.
- Verified ClawHub OIDC child skips `clawhub-plugin-release`, then uses its own publication authorization. Core completion/failure must not strand authorized ClawHub; retain lane-local live-authority/exact-byte checks.
- npm children (`Plugin NPM Release`, `openclaw-npm-release.yml`) skip `npm-release` approval on verified route and publish in trusted-publisher-bound `npm-publish`. Immediately before publication, wait for parent attempt's receipt and require that attempt `in_progress`.
- `npm-publish` has no reviewers; admits only protected `release-publish/<sha12>-<n>` tags. Real manual/recovery npm dispatches require that tooling tag and their own `npm-release` approval. Read-only OIDC preflight also uses `npm-publish`/tag; artifact-only preflights retain refs/no environment.
- Never hand-approve `plugin-clawhub-release.yml`: bot route is receipt-verified, no approval. Missing `openclaw-clawhub-recovery-approval-<run>-1` artifact is a nonfatal probe. Historical parent-bound failure `parent state completed/failure is not allowed by authorization route` (2026.9.6, runs **35930335388/35930341394**): use [explicit recovery](../../release-openclaw-maintainer/references/publication-recovery.md#interrupted-preparation-and-publication), never hold/redispatch core. Bootstrap `plugin-clawhub-new.yml` always waits on `clawhub-plugin-bootstrap`; approve after secretless pack jobs ([first package](../../release-openclaw-maintainer/references/first-package.md)).

#### ClawHub recovery

Historical awaited v2 children could stage most packages, then one failure failed parent and prevented sibling finalization. New publication isolates this to ClawHub:

- Reconcile original child's `*-publish-json` artifacts before republishing/resuming parent.
- `pnpm release:clawhub-recovery -- --version <version> --reason '<parent failure>' --clawhub-source <isolated pinned ClawHub checkout> <package-publish.json>...` prints exact attempt recovery commands; recovery guide owns pinned source CLI/authorized execution.
- Public version 404 does not distinguish staged/missing; attempt status needs publisher auth. Parent receipts/live-authority revalidation still required; recovery never makes failed parent successful evidence.

#### Stale children

- Before npm dispatch, parent sweeps selected failed-parent `waiting`/`queued` npm children for the same release: core by `parent=<run>/<attempt>` title; plugins by Release SHA, only with no other live publish parent. Independent ClawHub lane owns its sweep.
- Each owner tries gate rejection/cancellation and waits up to **5 minutes per workflow**. Rejection 403 needs reviewer; logs/summary provide reject/cancel commands. Unconfirmed cancellation warns. Core's independent slot/live-parent recheck avoids blocking; target-serialized plugin npm refuses new dispatch until cancellation confirmed.
- ClawHub reconciliation/serialized slots/guards remain independent: never hold npm dispatch/core completion or cancel authorized ClawHub because core parent failed. Core failure cancels its waiting npm children. Detached ClawHub parent failure rejects recorded child's pending gate before cancellation; unconfirmed rejection warns with reviewer commands.
- Reviewer cleanup of confirmed stale, no-longer-authorized children: list this release's `workflow_dispatch` runs by `github-actions[bot]`, reject gate, cancel:

  ```bash
  for s in waiting queued; do gh api "repos/openclaw/openclaw/actions/runs?status=$s&per_page=100" \
    --jq '.workflow_runs[] | select(.event=="workflow_dispatch" and .actor.login=="github-actions[bot]") | select(.name | test("plugin-clawhub|Plugin NPM Release|openclaw-npm-release")) | [.id,.name,.created_at] | @tsv'; done
  env_id=$(gh api repos/openclaw/openclaw/actions/runs/<child>/pending_deployments --jq '.[0].environment.id')
  gh api -X POST repos/openclaw/openclaw/actions/runs/<child>/pending_deployments \
    -f state=rejected -f comment="Reject stale release gate" -F "environment_ids[]=$env_id"
  gh run cancel <child> --repo openclaw/openclaw
  ```

- Plugin npm `gh run rerun --failed` breaks attempt-bound preflight artifact readback. Parent waits for original child settlement and propagates failure, without replacement dispatch. Diagnose/fix owner before explicit recovery; preserve successful immutable packages/evidence.
