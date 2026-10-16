# Native release platforms

## Decoupling

npm + ClawHub publication is the priority path. Native app publication
(macOS, Windows, Linux, Android) runs in parallel and never gates it: a native
failure is classified and fixed in parallel, not a reason to re-cut or re-run
npm validation. Each native lane starts as soon as its own prerequisites
exist, alongside npm publication rather than queued behind it: macOS from the
tag and exact source; the Linux and Windows publishers from
`finalize_github_release`, which they require.

Apps are independent publication tasks. They do not block npm, Docker, GitHub
release finalization, or stable main closeout. Record pending platforms
explicitly and call each complete only after its assets and updater evidence
verify. Beta skips native publication unless requested; extended-stable never
inherits these platforms.

## macOS

An explicit stable or full release request includes macOS publication unless
the operator limits its scope. Continue without a separate macOS consent step,
following the current owner-configured environment policy. Preserve enforced
rules and the exact-source validation, signing, and promotion checks.

Use `$release-openclaw-mac` for public handoff validation, release-ops
validation, signing/notarization preflight, and promotion. Use `$release-private`
for credential topology. A smoke-test artifact with ad-hoc signing proves no
release readiness. Real publish reuses the successful notarized preflight and
validation for the same tag/source SHA.

Start the macOS validate and preflight lanes right after the tag push, before
core npm moves `latest`. The preflight's `pnpm release:check` requires npm
`latest` and `beta` in the tag's update compatibility inventory, and the tag
cannot record its own version. If `latest` flips first, record the new version
on `release/YYYY.M.PATCH` and preflight with that `source_ref`. The real publish
reuses the preflight and does not rerun the check.

The real publish (`openclaw-macos-publish.yml` in `openclaw/releases`) attaches
assets to the GitHub release whether it is still a draft or public. Let the
selected publisher activate the release after its required checks; do not
make a draft public to bypass a failed gate. See
[publication recovery](publication-recovery.md). A re-dispatched preflight for the same tag
and source resumes every variant from its newest checkpoint without rebuilding;
`ignore_checkpoints=true` forces a rebuild and `resume_notarization_run_id`,
`resume_notarization_run_attempt`, `resume_notarization_variant` only pin one
specific run. The appcast lands as an auto-opened PR
`chore(release): update appcast for <version>` that must be merged; macOS is
not complete until it is. Record preflight/publish run ids in the handoff.

For mac-only packaging/signing/workflow fixes after npm is published, preserve
the original tag and use `source_ref=release/YYYY.M.PATCH` plus
`public_release_branch=release/YYYY.M.PATCH`. Prove this source descends from the
tag and both validation and preflight select it. Do not mint a new npm release
identity for an app-only recovery.

The stable production Sparkle feed is `appcast.xml` on public main. Serialize
appcast-producing runs; prepare its signature before asset upload, then verify
the feed points to the published zip. Recover from the successful run's signed
`macos-appcast-<tag>` artifact or complete the workflow's appcast PR. Beta must
not update the shared production feed without a separate beta feed.

If release-ops publishing is unavailable, the private mac runbook owns the
local fallback on a credentialed real Mac: `scripts/package-mac-dist.sh`, asset
upload, then `scripts/make_appcast.sh` and the stable appcast commit. The package
must have the release bundle ID, nonempty feed URL, and numeric build at or
above the canonical Sparkle floor; correction tags need a higher `APP_BUILD`.
The appcast helper finds `generate_appcast` on PATH or in SwiftPM output.
Verify zip, DMG and dSYM zip assets, short version, numeric build, and stable
feed before declaring macOS complete.

## Linux

Regular stable publication automatically dispatches `Linux App Release Request`
from current `main` after GitHub activation, through both `OpenClaw Release
Publish` and `OpenClaw Release Button`. The request selects the immutable stable
tag and leaves `desktop-test-bundles=false`. A successful request is pending
publication, not proof that the Linux app shipped; follow its `Linux App Release`
builder and verify the AppImage, `.deb`, signed `latest.json`, and
`SHA256SUMS.linux-app.txt` before reporting Linux complete.

A successful request is reused even if its independent builder later fails;
recover the builder rather than expecting a core publication retry to rebuild it.

After Linux assets publish, complete the [website download handoff](#website).
Published GitHub assets alone do not complete the website's build-time links.

For independent recovery, dispatch `Linux App Release Request` from `main` with
the same `tag`. A default Linux-only retry reuses verified complete assets;
partial assets require targeted recovery, never rebuilding or clobbering
published bytes. Inspect an unconfirmed request before redispatching it.

The stable updater endpoint stays at `releases/latest/download/latest.json`.
Before a new latest release becomes visible, the publisher preserves the
previous usable Linux manifest with its original version, signature, and asset
URL. One post-build publisher writes immutable `OpenClaw-<version>-linux.json`,
advances the fixed `linux-stable` canonical manifest only forward, and mirrors
it to the current latest release. Asset completeness and unfinished channel
publication are separate: retrying complete public assets verifies and reuses
their bytes and identities, then completes only the remaining metadata work.
When Windows companion publication is enabled (see below), the signed Windows
updater manifest exists only in the building run until published, so a publication interrupted before `latest-windows.json` recovers by
rerunning that run's publish job (it passes its signed inputs and refuses any
byte mismatch); a fresh request reuses public bytes and cannot recreate it.

The immutable publication's asset inventory stays strict for the AppImage,
`.deb`, and `SHA256SUMS.linux-app.txt`. A non-Linux companion it records (the
Windows `.exe` or desktop-test macOS bundles) may be withdrawn by deleting the
release asset; status and stable closeout then report it as
`withdrawnCompanionAssets` while the immutable checksum file keeps its row. A
companion that is still present must match its recorded id, size, and digest.

Windows Tauri companion publication is temporarily disabled by
`WINDOWS_COMPANION_RELEASE: "false"` in `.github/workflows/linux-app-release.yml`:
release tags were shipping unplanned Windows installers from sources without
Windows local Gateway support. Until it is deliberately re-enabled, regular
releases build, sign, and publish only the AppImage, `.deb`, and
`SHA256SUMS.linux-app.txt` (a 3-asset Linux publication). Expect no
`OpenClaw-<version>-windows-x86_64.exe`, `latest-windows.json`, or
`windows-stable` update; treat any as unplanned and withdraw it. Opt-in
desktop-test requests still attach their test Windows installer but publish
no `windows-stable` channel. Re-enable by setting the switch to `"true"` in a
reviewed `main` PR before dispatching the request. This switch does not
affect the Windows Hub lane below.

An authorized Linux publication creates the `linux-stable` control release as
prerelease/non-latest when absent; ordinary PR validation never initializes it.
This tooling does not change shipped updater or
download URLs. Keep client cutover and signed installed-client migration under
separate approval; never claim local helper tests or unsigned packages prove it.

Creating `linux-stable` requires the release-owner GitHub App's contents and
workflows permissions; `GITHUB_TOKEN` is insufficient. For an approved client
migration, compare versions using the shipped old updater's comparator.

Core finalization does not depend on canonical Linux metadata. After successful
finalization/readback, a bounded detached mirror-only request uses the original
validated publisher identity. It does not wait for the metadata queue in the
core workflow. Dispatch acceptance is not success: cancellation, queue overflow,
timeout, and readback failures must remain visibly degraded. The mirror and
post-build publisher share serialization; Linux builds use a separate queue.
Each write revalidates the active executing writer and original parent attempt
after preparatory reads, including after a deletion and before its replacement.

Verify both canonical and legacy endpoints after publication, including when a
newer Gateway release appeared during the Linux build. If canonical metadata is
missing after an interrupted deletion, normal publication refuses recovery.
Have the release owner reconcile it explicitly: preserve the
last verified Linux floor and all intervening publication evidence, exclude
other writers, revalidate release/source/inventory and immutable bytes, and
read back both endpoints. Version/hash inputs or current Gateway `latest` alone
cannot establish forward order. Stop on ambiguous history.

## Windows Hub

The optional parent inputs `windows_node_tag` and
`windows_node_installer_digests` are supplied together. The source tag must be
exact and non-prerelease, with candidate-approved digests. The detached Windows
child runs after GitHub finalization; failure does not keep the release drafted.
To attach later or recover promotion:

```bash
gh workflow run windows-node-release.yml --repo openclaw/openclaw --ref main \
  -f tag=vYYYY.M.PATCH \
  -f windows_node_tag=vX.Y.Z \
  -f expected_installer_digests='{"OpenClawCompanion-Setup-x64.exe":"sha256:<approved-x64-sha256>","OpenClawCompanion-Setup-arm64.exe":"sha256:<approved-arm64-sha256>"}'
```

Verify canonical x64/arm64 installer assets and
`OpenClawCompanion-SHA256SUMS.txt`, expected Foundation Authenticode signer, and
redownloaded checksums. Recovery rejects unexpected contract asset names and
replaces expected assets with pinned bytes. Never republish npm for an app
failure. Website links must resolve to these assets at the intended stable tag;
verify a `latest` redirect before relying on it.

## Android

Pin the train before tagging under [preparation](preparation.md). Approval,
build and publication remain independent; record a skipped or failed Android
child without masking npm/GitHub results.

## Website

`openclaw/openclaw.ai` owns deployment and build-time companion download links.
After macOS, Linux, or Windows assets publish, use its existing **Companion
Downloads (deployed)** workflow, not an empty commit or a direct Vercel CLI deploy:

```bash
gh workflow run companion-downloads-deployed.yml --repo openclaw/openclaw.ai --ref main
```

This is a deployment-capable operation: use it only under release/deployment
authority. The operator needs GitHub permission to dispatch that site's workflow.
The project owner separately configures a production `main` Vercel Deploy Hook
and stores its URL as the site's `VERCEL_COMPANION_DEPLOY_HOOK` repository secret.
The workflow uses that credential; the operator does not need a Vercel CLI token.
A CLI permission denial therefore does not establish that this route is unavailable.
Follow the site's [deployment instructions](https://github.com/openclaw/openclaw.ai#companion-downloads)
for setup and read-only download checks; never print or copy the hook URL into a PR.

The workflow skips deployment when production is already current. Otherwise it
requests one rebuild and verifies both `/` and `/install/`, the expected site
source SHA in `/site-release.json`, and the real download responses. Record the
workflow run and its terminal result, not just dispatch acknowledgement. Preview
and deployment-status checks remain read-only.

Missing-hook failures require project-owner setup, not broader CLI privileges.
If a requested deployment times out or site `main` advances, inspect its outcome
before retrying. Do not republish the apps or edit website content to trigger a build.
