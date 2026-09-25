# Regular beta and stable release

## Orchestrated stable (default)

`pnpm release:stable YYYY.M.PATCH` drives the whole fast path from
`docs/reference/RELEASING.md` (cut → validate → publish → sync-beta →
flip-github → macos → closeout) with state in
`.artifacts/release-YYYY.M.PATCH/state.json`. Rerun to resume, `--from <phase>`
to restart a phase, `--status` to inspect, `--dry-run` to print every command.
Two prompts only: confirm the cut SHA (`--confirm-cut-sha <sha>` without a
terminal) and approve publication (`--approve-publication`). A refusal prints
`Next:` with the exact commands; run them, then resume. Use the manual sequence
below when the orchestrator refuses a step it cannot repair itself (editorial
changelog work, the compat inventory PR, an appcast PR, the closeout PR) or for
betas.

## Freeze and validate code

Read [preparation](preparation.md) before branch or version changes. Record the
approved version, cut SHA, release branch and product-complete Code SHA,
including final notes when ready. Use [validation](validation.md) to select
phase-specific gates and `$release-openclaw-ci` for dispatch/recovery.

The default is the fast path in `docs/reference/RELEASING.md`: one cut named
exactly `release/YYYY.M.PATCH` (no `-cutN` or staging suffixes), version
alignment plus changelog and contribution record in one commit so Code SHA =
Release SHA, one Tooling SHA frozen at dispatch, and one validation parent.
Record the cut time; aim to seal validation in approximately 20 minutes and
publish within an hour, with actual timing recorded separately. Backports are
merged `main` PRs cherry-picked before dispatch (pure-data model/catalog
additions and bundled-runtime bumps qualify); after dispatch admit only a fix
for a required-lane defect. A second cut (re-basing the candidate on newer
`main`) needs Peter's explicit request in that release; otherwise cherry-pick
merged `main` commits only for a confirmed release blocker and name each one in
the handoff record.

Run deterministic source preflight, then validate the exact Code SHA:

```bash
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"latest","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
node scripts/full-release-validation-at-sha.mjs \
  --sha <code-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha> \
  -f validation_purpose=publish -f publication_selection_json="$PUBLICATION_SELECTION"
```

Choose `npmDistTag=beta` for a beta or `route=prepared` for the prepared button.
Keep that intended selection on later notes-only parents. This admits committed
publication source, not registry eligibility or publication authority.

Record and reuse the full trusted Tooling SHA. Beta-publish uses
`release_profile=beta`, `run_release_soak=false` (`npm-beta-v1` for a qualifying
canonical beta target). Stable-publish defaults to `release_profile=stable` with
soak and performance dispatched in parallel; beta-profile evidence publishes a
stable only with `stable_soak_waiver` (RELEASING.md "Publication modes"). Diagnose
failures and use the controller's bounded retry for affected required proof.
Continue eligible parents to seal; a parent that produced its own sealed
candidate artifacts requires a new parent with verified successful evidence
reuse. Do not rerun advisory suites merely to obtain green results or infer a
flake from an untouched test or passing replay. Only a confirmed product
defect that a required lane blocks on creates a new Code SHA: the
update/install path (previous stable updates to the candidate, install smoke,
pack budget, worker bundle), the bytes to publish, or another required gate
proven by diagnosis. A flake, an advisory lane, or a publish-tooling re-tag
never does. Tooling,
credentials, infrastructure or wrapper failure keeps the candidate and recovers
the failed surface. Use [publication recovery](publication-recovery.md) for
classification. Keep PR CI and supporting workflows running while the parent
runs. Use the release recovery guidance in `docs/reference/RELEASING.md` only
for runs already deferred by historical workflows.

An early `OpenClaw Performance` run is optional beta confidence:
`target_ref=<code-sha>`, `profile=release`, `repeat=3`, deep profiling/live OpenAI
off, `fail_on_regression=false`. It may overlap validation; performance remains
advisory for every profile. Compare available agent-turn/resource,
Gateway startup ready/listen/RSS/CPU and CLI startup metrics against earlier
releases. Record regressions and investigate product impact without making
performance evidence a publication or closeout gate.

## Qualify publication bytes

If Code SHA already contains fully final notes, use the same successful fresh
Full Release Validation parent and attempt for Code and Release qualification.
Its exact npm/OCI descriptors must belong to that SHA and satisfy the selected
release profile's required gates. No second commit or validation run is needed
solely to name a Release SHA.

If notes change after Code qualification, use `$openclaw-changelog-update`
with current main for canonical PR provenance and commit the selected
`CHANGELOG/YYYY.M.PATCH.md`, with any matching record and root index updates.
The complete Code-to-Release delta must include that entry and only those
paths, without renames or deletions, to optionally use
`split-changelog-release-v1`. Historical root-only receipts retain
`changelog-only-release-v1`. The split path requires green Code product evidence
and fresh Release SHA npm qualification/Docker preparation; it does not reuse
the earlier package bytes. Any other source change requires fresh product
qualification.

For either path, final SDK reports cover both
beta and latest; publication selects the appropriate one. Run release-note,
package/install/update acceptance against these exact prepared bytes.

Review the Plugin SDK API diff. If it reports changes, record its reviewed
8-character acknowledgement digest; otherwise omit the acknowledgement.
Confirm the core npm version is unpublished. A plugin whose `YYYY.M.PATCH`
already exists on npm from an earlier slip is skipped by the publish plan when
its delta is release metadata only; record the skip, it is not a blocker. A
prepare-only request does not
authorize pushing publication tags: use an existing matching protected tooling
ref where available, otherwise report that qualification still needs one.
With publication/tag-push authority, create and push the protected lightweight `release-publish/<tooling-sha12>-<epoch>` tooling tag at the recorded
Tooling SHA (see `docs/reference/RELEASING.md`). The push may print a
`Cannot create ref due to creations being restricted` ruleset warning while the
tag still exists: verify with `gh api repos/openclaw/openclaw/git/ref/tags/<tag>`
and, only if missing, create it with
`gh api -X POST repos/openclaw/openclaw/git/refs -f ref=refs/tags/<tag> -f sha=<tooling-sha>`.
The tooling `main` must include #156816 (lane waiver forwarded to children) when
a lane waiver is in force. Then consume existing validation against the untagged
Release SHA:

```bash
pnpm release:candidate -- \
  --tag <tag> \
  --target-sha <release-sha> \
  --npm-dist-tag <beta-or-latest> \
  --publication-route <normal-or-prepared> \
  --full-release-run <release-sha-validation-run-id> \
  --publish-workflow-ref release-publish/<tooling-sha12>-<epoch> \
  --plugin-sdk-api-acknowledgement <reviewed-8-character-digest> \
  --skip-dispatch
```

Match `--npm-dist-tag` and `--publication-route` to the frozen validation
selection; the helper defaults to `beta` and `normal`.
`--publish-workflow-ref` selects the publication tag, not the helper checkout.
The same-checkout bootstrap fetches the workflow branch tip. Verify that the
executing helper's Tooling SHA matches the recorded tag; if it differs, use
only an owner-supported exact-tooling entry path, without moving the protected
tag or silently changing qualification identity.

Omit `--plugin-sdk-api-acknowledgement` when no API change exists. The helper
completes package/install proof and prints the selected route's next command; do not dispatch
another equivalent validation. Its `npm-beta-v1` Telegram package result is
`deferred-postpublish`, never passed. Other policies retain their check.
Parallels and Telegram package proof belong to postpublish confidence on every
track. A final version never records `npm-beta-v1`, so the helper runs both
for stable unless you pass `--skip-parallels --skip-telegram`; use
`--run-parallels` only on explicit operator direction. Optional
`--windows-node-tag <exact-source-tag>` records its approved installer digest
map; stable candidates do not require Windows. The default stable candidate is
validated with the beta profile and no soak: pass `--release-profile beta` and
the operator-approved `--stable-soak-waiver '<reason>'` using the standard
wording in `docs/reference/RELEASING.md`; the helper forwards it to the
embedded preflight and the printed publish command.

For a prepare-only request, stop with the candidate, evidence, limitations, and
printed next command. Do not create/push the final tag or publish/announce.
With publication authority and candidate success, create and push the signed
final tag at Release SHA. Leave GitHub Release creation/finalization to the
publish workflow. At this point start the selected macOS handoff, release-ops
validation, and notarization preflight through [platform publication](platform-publication.md)
while npm/plugin publication proceeds. These preparation lanes do not need a
published GitHub page; asset promotion waits for its required release state.
Keep their exact run/attempt identities in the handoff's publication rows.

## Publish and verify

Read [publication authentication and recovery](publication-recovery.md) and
keep the admitted publication route. For `prepared`, run the candidate's
printed `openclaw-release-prepare.yml` command after the frozen release tag
exists. Once preparation succeeds, pass its summary's `prepared_artifact` JSON
to `openclaw-release-button.yml` at the same protected Tooling tag. Follow
[the release-button procedure](../../../../docs/reference/RELEASING.md#prepare-once-then-use-the-release-button)
and its readiness receipt; do not also dispatch the normal publisher.

For `normal`, dispatch `.github/workflows/openclaw-release-publish.yml` using the candidate
helper's protected `release-publish/<tooling-sha12>-<epoch>` ref. Pass matching
`npm_dist_tag`, `preflight_run_id`, `full_release_validation_run_id` and its
exact successful `full_release_validation_run_attempt`. The sealed manifest
supplies SDK acknowledgement, npm decisions, and approved soak-waiver defaults;
explicit publisher inputs override them. The candidate helper retains its
explicit SDK acknowledgement when needed. Optional Windows source tag and
candidate-approved digests are supplied together or both omitted.

Wait for `npm-release` environment approval, plugin npm then core npm, parallel
ClawHub, npm postpublish verification, Docker publication, dependency/release
evidence, and GitHub finalization. Reuse successful immutable child artifacts
on recovery; never rebuild or republish successful versions. Each npm child
needs its own `npm-release` approval and ClawHub children must never be
approved by hand; watch `pending_deployments` on every child per
`$release-openclaw-ci` (Publish children). Children run on hosted
`ubuntu-latest`; if that pool is saturated, let jobs queue normally without
cancelling PR CI. Blacksmith testbox runs use a separate pool.

After the core child logs `+ openclaw@<version>`, the package takes 5-6 minutes
to appear in `npm view openclaw versions --json --prefer-online`; poll it before
the dist-tag sync, the GitHub flip, or verification. Run postpublish
verification from a checkout of the Release SHA (a newer tooling checkout
reports main-only bundled plugin files as missing), with the tooling identity
exported, or it fails `SHA-pinned release-publish ref does not match`:

```bash
OPENCLAW_NPM_EXPECTED_WORKFLOW_REF=refs/tags/release-publish/<tooling-sha12>-<epoch> \
OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA=<tooling-sha> \
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <version>
```

If the parent fails at `Complete publish workflows` (it requires `beta` ==
`latest` for every package) after core published, do not re-publish: run the
dist-tag sync, sweep stale children, and dispatch a new parent with the same
inputs; already-published bytes are recognized and it only runs ClawHub, GitHub
release evidence, and Docker.

As soon as `openclaw@<version>` is visible on npm under the target dist-tag,
flip the GitHub release public: un-draft it and mark it latest for stable.
Never wait for Docker, ClawHub, the app publishers, or the parent's finalize
step; the macOS publisher requires the public release. Dispatch the
`sync_beta_to_stable` dist-tag sync right after core npm and before the parent's
completion verify, which fails on a stale `beta` tag. If the parent has not
flipped it, run
`gh release edit v<version> --repo openclaw/openclaw --draft=false --latest`.

Native applications use [platform publication](platform-publication.md) as
independent tasks; beta runs them only if requested. Their approval, build,
signing or promotion does not delay npm/GitHub finalization. Recover an app
failure without republishing npm.

## Confidence and promotion

Run [postpublish confidence](validation.md#postpublish-confidence) against the
exact published package. For a beta-to-latest promotion, retain available
deferred-lane results, including published-package Telegram, while enforcing
the shared required publication proofs. Ordinary test outcomes remain advisory;
a direct stable publish under the soak waiver runs confidence after publication. Run safe
independent rosters concurrently while controlling local Docker/VM load.
Classify failures before admitting a fix to the next beta; do not scan moving
main or automatically rerun all groups. An operator's beta-attempt cap counts
approved product attempts, not infrastructure failures.

Campaign generation belongs to `$openclaw-release-validation` and is not a
publish blocker. Requested Discord announcements use
`$release-openclaw-announcement`; requested X posts use `$release-tweets`.
Existing explicit posting authorization is required. Beta-only requests end
after verification and any requested announcement.

For an authorized stable promotion, reuse the matching beta's full confidence
when still applicable. Run published npm verification, Docker install/update,
macOS-only Parallels smoke and advisory QA signal; broaden only for stale
proof, material stable/beta differences, or explicit retesting. Promote beta to
latest through the restricted dist-tag workflow in
[publication recovery](publication-recovery.md#registry-selectors). After either
publishing or promoting to latest, immediately repair the beta floor through
that owner and verify each selector readback; preserve any newer beta.

Complete [stable main closeout](stable-main-closeout.md) once version,
changelog, npm and Docker evidence are ready. Record pending apps and monitor
them independently; verify each platform's assets/updater before announcing it
complete.
