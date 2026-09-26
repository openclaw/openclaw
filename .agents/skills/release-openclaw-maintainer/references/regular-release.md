# Regular beta and stable release

## Orchestrated stable release

Use the [manual publication flow](#publish-and-verify) when activation must wait for the
selected publisher's gates. The current orchestrator activates GitHub as soon
as npm is visible; it does not enforce that finalizer ordering. Do not use it
without explicit operator approval for that early activation.

`pnpm release:stable YYYY.M.PATCH` runs strict stable qualification and publication as one resumable state
machine with the phases `cut → validate → publish → sync-beta → flip-github →
macos → closeout`. State lives in `.artifacts/release-YYYY.M.PATCH/state.json`;
rerunning the command continues from the first incomplete phase, `--from <phase>`
restarts from that phase, `--status` prints the table, and `--dry-run` prints
every command it would run without executing anything. The operator answers
exactly two prompts: confirm the cut SHA (`--confirm-cut-sha <sha>` when there
is no terminal) and approve publication (`--approve-publication`). Every refusal
prints `Next:` with the exact commands to run before resuming.

Each phase runs the existing helpers, in the order the manual fallback below
describes: `cut` creates `release/YYYY.M.PATCH` at the confirmed SHA and refuses
until version, changelog, and contribution record are on the branch tip;
`validate` tags `release-publish/<sha12>-<epoch>` once at the tooling SHA,
dispatches `pnpm ci:full-release` with `release_profile=stable` and
`run_release_soak=true` (matching nightly evidence is reused by the helper),
retains the exact observed validation request, and stops on a failed parent for
diagnosis and operator recovery; `publish` runs
`pnpm release:candidate`, pushes the final tag, starts the macOS validate and
preflight lanes from the tag, dispatches `OpenClaw Release Publish` once with
`wait_for_clawhub=false`, approves the parent's `npm-release` gate, and
completes when `openclaw@YYYY.M.PATCH` is visible on npm; it never approves or
cancels a child run (the API cannot prove which parent dispatched one), so
when those capabilities are absent it prints the exact child-approval and
stale-child sweep commands for the operator instead; `sync-beta` advances the
beta dist-tag to the already-published stable version; `flip-github` un-drafts the release and marks it latest;
`macos` waits for the preflight, dispatches the real publish, and requires the
appcast on `main`; `closeout` waits for the publish parent, requires the exact
shipped version and changelog on `main`, and dispatches the closeout run unless
the release already carries the closeout manifest and checksum assets.

The orchestrator probes three capabilities and otherwise falls back to today's
manual commands: a publish parent at the tooling SHA that runs the dist-tag
sync itself (`sync-beta` verifies for 20 minutes before dispatching the sync),
a parent that sweeps its predecessors' stale children (`sweep_superseded_children`;
otherwise the sweep commands are printed before dispatch), and npm children
that publish in `npm-publish` behind the parent approval receipt
(`environment: npm-publish` in `openclaw-npm-release.yml` at the tooling SHA;
otherwise child approval commands are printed). Runs dispatched on `main` are reconciled by
workflow path, ref, the operator's own login, and a ten-minute window; two
matches refuse instead of guessing.
Pass `--plugin-sdk-api-acknowledgement` when the candidate reports SDK API
changes, and `--from macos --macos-preflight-run-id <id>` /
`--macos-validate-run-id <id>` after a manual notarization resume. A state
directory is bound to one cut and one tooling SHA; selecting another needs a
fresh `--state-dir`, which the refusal prints.

The current orchestrator directly activates GitHub in `flip-github`. This
differs from the publisher finalizer ordering described below; it does not
prove that the publisher's activation or Docker gates passed. For the manual
flow, let the selected publisher complete those gates.

## Freeze and validate code

Read [preparation](preparation.md) before branch or version changes. Record the
approved version, cut SHA, release branch and product-complete Code SHA,
including final notes when ready. Use [validation](validation.md) to select
phase-specific gates and `$release-openclaw-ci` for dispatch/recovery.

Use one release cut named
exactly `release/YYYY.M.PATCH` (no `-cutN` or staging suffixes), version
alignment plus changelog and contribution record in one commit so Code SHA =
Release SHA, one Tooling SHA frozen at dispatch, and one validation parent.
Record the cut time; aim to seal validation in approximately 20 minutes and
publish within an hour, with actual timing recorded separately. Backports are
merged `main` PRs cherry-picked before dispatch (pure-data model/catalog
additions and bundled-runtime bumps qualify); after dispatch admit only a fix
for a required-lane defect. A second cut (re-basing the candidate on newer
`main`) requires the approval specified in the parent skill's
[release authority rules](../SKILL.md#shared-release-boundaries); otherwise cherry-pick
merged `main` commits only for a confirmed release blocker and name each one in
the handoff record.

Run deterministic source preflight, then validate the exact Code SHA:

```bash
PUBLICATION_SELECTION='{"route":"normal","npmDistTag":"beta","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}'
node scripts/full-release-validation-at-sha.mjs \
  --sha <code-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha> \
  -f validation_purpose=publish -f publication_selection_json="$PUBLICATION_SELECTION" \
  -f release_profile=stable -f run_release_soak=true
```

This example qualifies a final version for beta-first publication. Select
`npmDistTag=latest` for approved direct stable publication, or `route=prepared`
for the prepared button. A beta prerelease uses the beta profile and soak policy.
Keep that intended selection on later notes-only parents. This admits committed
publication source, not registry eligibility or publication authority.

Record and reuse the full trusted Tooling SHA. Beta-publish uses
`release_profile=beta`, `run_release_soak=false` (`npm-beta-v1` for a qualifying
canonical beta target). Stable-publish requires `release_profile=stable` or
`full`, soak, and blocking performance. Beta-profile evidence cannot qualify
stable, and every selected validation lane must pass. See
[validation](validation.md) and
[publication recovery](publication-recovery.md). Diagnose
failures and use the controller's bounded retry for affected required proof.
Continue eligible parents to seal; a parent that produced its own sealed
candidate artifacts requires a new parent with verified successful evidence
reuse. Diagnose selected test failures before rerunning; an untouched test or
passing replay alone does not prove a flake or a fix. Only a confirmed product
defect that a required lane blocks on creates a new Code SHA: the
update/install path (previous stable updates to the candidate, install smoke,
pack budget, worker bundle), the bytes to publish, or another required gate
proven by diagnosis. A diagnosed infrastructure flake or a publish-tooling re-tag never does. Tooling,
credentials, infrastructure or wrapper failure keeps the candidate and recovers
the failed surface. Use [publication recovery](publication-recovery.md) for
classification. Keep PR CI and supporting workflows running while the parent
runs. Use the [release CI recovery guidance](../../release-openclaw-ci/SKILL.md#deferred-ci-recovery)
only for runs already deferred by historical workflows.

An early `OpenClaw Performance` run is optional beta confidence:
`target_ref=<code-sha>`, `profile=release`, `repeat=3`, deep profiling/live OpenAI
off, `fail_on_regression=false`. It may overlap validation. Stable/full
qualification requires blocking performance; every selected performance child
must succeed. Compare available agent-turn/resource, Gateway startup
ready/listen/RSS/CPU and CLI startup metrics against earlier releases. Record
regressions and resolve blocking failures before publication or closeout.

## Qualify publication bytes

If Code SHA already contains fully final notes, use the same successful fresh
Full Release Validation parent and attempt for Code and Release qualification.
Its exact npm/OCI descriptors must belong to that SHA and satisfy the selected
release profile's required gates. No second commit or validation run is needed
solely to name a Release SHA.

If notes change after Code qualification, use `$openclaw-changelog-update`
with current main for the canonical PR history and commit the selected
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
With publication/tag-push authority, pass `--workflow-sha <tooling-sha>` to
`pnpm release:candidate --` or `pnpm release:publish-preflight --` to reuse or
mint the protected lightweight `release-publish/<tooling-sha12>-<epoch>` tag
through the git refs API, verify it, and print the dispatch with `--ref <tag>`.
Manual tag creation remains the fallback. The push may print a
`Cannot create ref due to creations being restricted` ruleset warning while the
tag still exists: verify with `gh api repos/openclaw/openclaw/git/ref/tags/<tag>`
and, only if missing, create it with
`gh api -X POST repos/openclaw/openclaw/git/refs -f ref=refs/tags/<tag> -f sha=<tooling-sha>`.
Then consume existing validation against the untagged Release SHA:

```bash
pnpm release:candidate -- \
  --tag <tag> \
  --target-sha <release-sha> \
  --npm-dist-tag <beta-or-latest> \
  --release-profile <beta-stable-or-full> \
  --publication-route <normal-or-prepared> \
  --full-release-run <release-sha-validation-run-id> \
  --workflow-sha <tooling-sha> \
  --plugin-sdk-api-acknowledgement <reviewed-8-character-digest> \
  --skip-dispatch
```

Match channel, route, and profile to the frozen validation selection. The
channel and route default to `beta` and `normal`; final versions require
stable/full evidence with soak and blocking performance, even on the beta channel.
`--workflow-sha` pins both the helper checkout and publication tag to the recorded
Tooling SHA. Alternatively, `--publish-workflow-ref` selects an existing
publication tag while the same-checkout bootstrap fetches the workflow branch
tip; verify that the executing helper's Tooling SHA matches that tag, without
moving it or silently changing qualification identity.

Omit `--plugin-sdk-api-acknowledgement` when no API change exists. The helper
completes package/install proof and prints the selected route's next command; do not dispatch
another equivalent validation. Its `npm-beta-v1` Telegram package result is
`deferred-postpublish`, never passed. Other policies retain their check.
Parallels and Telegram package proof belong to postpublish confidence on every
track. A final version never records `npm-beta-v1`, so the helper runs both
for stable unless you pass `--skip-parallels --skip-telegram`; use
`--run-parallels` only on explicit operator direction. Optional
`--windows-node-tag <exact-source-tag>` records its approved installer digest
map; stable candidates do not require Windows asset publication. Stable
candidates require stable/full evidence with soak and blocking performance.
The embedded preflight enforces these requirements; no publication waiver can
bypass them.

For a prepare-only request, stop with the candidate, evidence, limitations, and
printed next command. Do not create/push the final tag or publish/announce.
With publication authority and candidate success, create and push the signed
final tag at Release SHA. Leave GitHub Release creation/finalization to the
publish workflow. At this point start the selected macOS handoff, release-ops
validation, and notarization preflight through [platform publication](platform-publication.md)
while npm/plugin publication proceeds. These preparation lanes do not need a
published GitHub page; asset promotion waits for its required release state.
Keep their exact run/attempt identities in the handoff's publication rows.

## Prepared publication

For a complete regular beta or stable release, use `OpenClaw Release Prepare`
before publication and `OpenClaw Release Button` when ready to publish. Both run
from the same frozen `release-publish/<sha12>-<id>` tooling tag. The existing
release tag, successful npm preflight, exact Full Release Validation attempt,
reviewed SDK evidence, and any explicitly selected Windows source evidence
must already be available. The publisher consumes sealed acknowledgement defaults;
the candidate helper retains its explicit SDK acknowledgement argument. This does not create a version or release tag.

Run `pnpm release:candidate` with `--publish-workflow-ref` set to that protected
tag. Its evidence bundle and terminal output include a **prepare once** command
for complete regular releases. After creating the frozen release tag, run that
command. It dispatches the existing npm and ClawHub preflight workflows in
parallel, builds and qualifies their final package bytes, and seals a readiness
receipt only after every package can be downloaded and verified. Preparation
does not publish packages or change public selectors.

Every ClawHub package must already have the normal trusted-publisher binding.
Preparation refuses to issue a readiness receipt for packages needing bootstrap
or publisher repair; use the existing ClawHub owner workflow to finish that setup
first. The button rechecks this prerequisite before starting any plugin writer.

When preparation succeeds, copy its summary's `prepared_artifact` JSON into
**OpenClaw Release Button**, selecting the same protected tooling tag. This is
the only input needed for a new publication: the receipt contains the release tag,
channel, validation references, complete package inventories, and exact artifact
IDs, digests, producer runs and attempts. The button invokes the existing
protected publisher; existing environment approvals and registry authority
checks remain in force. The receipt seals plugin readiness; the existing parent
revalidates the core npm, Full Release Validation, and Windows evidence before
dispatching publication.

The publisher verifies the complete prepared npm and ClawHub package set before
starting any plugin writer. Plugin jobs restore and upload those exact bytes;
they do not install source dependencies, rebuild, or repack them. Packages that
are already present must match the prepared integrity and canonical public
tarball before they can be adopted. Core npm and Docker retain their existing
prepared-artifact and release-evidence checks. Because ClawHub's publication
authorization depends on terminal parent success, the outer button waits for
the publisher and then verifies ClawHub's canonical public downloads. Only then
does it make the GitHub draft release visible.

Optional stable Windows promotion starts after that outer activation, using the
same sealed source tag, installer digests, and protected tooling. The ordinary
unprepared publisher retains its own post-finalization Windows job; the two
routes do not both dispatch. Missing Windows selection skips promotion, an
incomplete selection fails visibly, and alpha/beta never dispatch it. Windows
failure does not undo npm or GitHub publication. Inspect the attempt-bound
Windows dispatch artifact and linked child before an explicit manual retry;
neither publisher waits for native completion.

This button covers core and plugin npm, ClawHub, the existing Docker/Windows
contracts, and GitHub release visibility. It does **not** claim that independent
macOS signing/feed promotion, Android completion, app-store submission, or
website publication is ready. Those owners retain their existing release steps.
Alpha, selected-plugin repairs, and historical releases without a readiness
receipt continue to use their existing owner workflows. Extended-stable uses
the shared direct publisher with its dedicated track inputs, not this button.

## Publish and verify

Read [publication authentication and recovery](publication-recovery.md) and
keep the admitted publication route. For `prepared`, run the candidate's
printed `openclaw-release-prepare.yml` command after the frozen release tag
exists. Once preparation succeeds, pass its summary's `prepared_artifact` JSON
to `openclaw-release-promote.yml` at the same protected Tooling tag. Follow
[publication recovery](publication-recovery.md)
and its readiness receipt; do not also dispatch the normal publisher.

For `normal`, dispatch `.github/workflows/openclaw-release-publish.yml` using the candidate
helper's protected `release-publish/<tooling-sha12>-<epoch>` ref. Pass matching
`npm_dist_tag`, `preflight_run_id`, `full_release_validation_run_id` and its
exact successful `full_release_validation_run_attempt`. The sealed manifest
supplies SDK evidence and npm decisions;
explicit publisher inputs override them. The candidate helper retains its
explicit SDK acknowledgement when needed. Optional Windows source tag and
candidate-approved digests are supplied together or both omitted.

Wait for the parent's `npm-release` environment approval, plugin npm then core npm, parallel
ClawHub, npm postpublish verification, Docker publication, dependency/release
evidence, and GitHub finalization. Reuse successful immutable child artifacts
on recovery; never rebuild or republish successful versions. The parent's
approval receipt lets the npm and ClawHub children skip their human gates.
The npm children publish in `npm-publish` from the same protected tooling tag
and require the parent attempt to remain live. Direct human npm recovery still
requires its own `npm-release` approval. ClawHub children must never be approved
by hand; follow `$release-openclaw-ci` (Publish children). Children run on hosted
`ubuntu-latest`; if that pool is saturated, let jobs queue normally without
cancelling PR CI. Blacksmith testbox runs use a separate pool.

After the core child logs `+ openclaw@<version>`, verify public availability with
`npm view openclaw versions --json --prefer-online`; the log alone does not
prove availability. The parent's
`Complete publish workflows` step polls the registry document for the version
under the target dist-tag (bounded 10 minutes), then dispatches the
`sync_beta_to_stable` ledger sync through a release-ledger app token and waits
for it before verification; if its summary reports the token unavailable,
dispatch the sync by hand before the verify runs. For manual work, poll the
registry yourself before the sync or verification. Run postpublish
verification from a checkout of the Release SHA (a newer tooling checkout
reports main-only bundled plugin files as missing), with the tooling identity
exported, or it fails `SHA-pinned release-publish ref does not match`:

Set `TARGET_ROOT` to that checkout's absolute path, with unchanged tracked source
and index, and `TARGET_SHA` to the recorded full product Release SHA matching HEAD.
Set `TOOLING_ROOT` to the qualified trusted tooling checkout. Keep the Release SHA
checkout as the working directory, but invoke the trusted verifier below, not a
historical target script. Worker requirements come from the selected commit.

```bash
OPENCLAW_NPM_EXPECTED_WORKFLOW_REF=refs/tags/release-publish/<tooling-sha12>-<epoch> \
OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA=<tooling-sha> \
node --import "$TOOLING_ROOT/scripts/tsx.mjs" \
  "$TOOLING_ROOT/scripts/openclaw-npm-postpublish-verify.ts" \
  <version> "$TARGET_ROOT" "$TARGET_SHA"
```

If `Complete publish workflows` fails after core publication, inspect the
original child and registry evidence before recovery. Core and every published
official plugin require **beta at or above latest**, not equality. Repair stale
floors through [registry selectors](publication-recovery.md#registry-selectors),
preserving newer beta versions. Resume incomplete stages through the selected
route; never republish successful immutable versions.

Normal publication finalizes GitHub after npm and Docker verification. The
prepared button also verifies public ClawHub downloads before activation. Let
the selected finalizer make the draft public; do not manually bypass failed
gates. The explicitly approved `finalize_release_before_docker=true` direct
route changes ordering only; it retains activation approval and still requires
Docker for parent success. It does not apply to prepared publication or waive
stable validation.

Native applications use [platform publication](platform-publication.md) as
independent tasks; beta runs them only if requested. Their approval, build,
signing or promotion does not delay npm/GitHub finalization. Recover an app
failure without republishing npm.

## Confidence and promotion

Run [postpublish confidence](validation.md#postpublish-confidence) against the
exact published package. For a beta-to-latest promotion, retain available
deferred-lane results, including published-package Telegram, while enforcing
the shared required publication proofs. All selected test outcomes must pass
before publication. Run safe
independent rosters concurrently while controlling local Docker/VM load.
Classify failures before admitting a fix to the next beta; do not scan moving
main or automatically rerun all groups. An operator's beta-attempt cap counts
approved product attempts, not infrastructure failures.

Campaign generation belongs to `$openclaw-release-validation` and is not a
publish blocker. Requested Discord announcements use
`$release-openclaw-announcement`; requested X posts use `$release-tweets`.
Existing explicit posting authorization is required. Beta-only requests end
after verification and any requested announcement.

Stable publication and any dist-tag promotion to `latest` require exact
stable/full validation with soak, blocking performance, and successful selected
lanes. Matching beta-profile evidence never qualifies stable. Run published npm
verification, Docker install/update, and selected platform checks against the
qualified stable candidate. Promote beta to latest through the restricted dist-tag workflow in
[publication recovery](publication-recovery.md#registry-selectors). After either
publishing or promoting to latest, immediately repair the beta floor through
that owner and verify each selector readback; preserve any newer beta.

Complete [stable main closeout](stable-main-closeout.md) once version,
changelog, npm and Docker evidence are ready. Record pending apps and monitor
them independently; verify each platform's assets/updater before announcing it
complete.
