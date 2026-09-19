# Native release platforms

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

The website resolves desktop download assets at build time. After Linux assets
publish, rebuild `openclaw.ai` through its existing deployment owner and verify
the deployed Apps card shows the intended version and both download URLs resolve
to that tag's assets. Published GitHub assets alone do not complete the website
download handoff.

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

An authorized Linux publication creates the `linux-stable` control release as
prerelease/non-latest when absent; ordinary PR validation never initializes it.
This tooling does not change shipped updater or
download URLs. Keep client cutover and signed installed-client migration under
separate approval; never claim local helper tests or unsigned packages prove it.

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
Use the explicit owner reconciliation procedure in
`docs/reference/RELEASING.md` under **Linux companion publication**: preserve the
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
