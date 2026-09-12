# Native release platforms

Apps are independent publication tasks. They do not block npm, Docker, GitHub
release finalization, or stable main closeout. Record pending platforms
explicitly and call each complete only after its assets and updater evidence
verify. Beta skips native publication unless requested; extended-stable never
inherits these platforms.

## Linux companion

`Linux App Release Request` and `Linux App Release` own Linux bundle
publication. Keep the `linux-stable` control tag fixed and its release
prerelease/non-latest. The download landing page is
`https://github.com/openclaw/openclaw/releases/tag/linux-stable`; the updater
reads `/releases/download/linux-stable/latest.json`. Versioned bundles remain
on their original release, not copied onto unrelated core releases.

The publication helper separates two operations:

- `publish` verifies signed, publicly available assets and preserves immutable
  `OpenClaw-<version>-linux.json` bytes carrying source, tooling, and channel
  SHAs plus asset identities. It forward-promotes the canonical manifest,
  then mirrors it.
- `mirror` binds the selected core tag/SHA and actual latest release around
  writes. It copies the verified canonical manifest bytes without rebuilding
  Linux bundles.

Preserve successful manifest bytes, including `pub_date`, on retry. Identical
versioned bytes may be reused; conflicting bundle bytes or same-version
manifest bytes must stop. Verify public availability, signatures, identity,
and readback, not just authenticated access to draft assets or a signature
field in JSON. Reconcile partial canonical/mirror success without claiming
transactional writes or uninterrupted feed availability.

After GitHub finalization, core makes only a bounded detached mirror-only
dispatch to the existing Linux release workflow for the legacy
`/releases/latest/download/latest.json` mirror. Do not place a waiting mirror
job inside the core parent's top-level concurrency or wait for its completion
there. Dispatch acceptance is not mirror success: verify the detached outcome
and manifest readback separately. This path does not change native-build
admission. Keep mirroring until explicit retirement, including core releases
without a new Linux build. Dispatch or mirror failures must be visibly degraded
and recoverable without blocking npm, Docker, GitHub finalization, or
main closeout. Do not treat core success as mirror success or republish core
packages to repair the mirror. Canonical release notes link to the latest
published Linux companion, not a promise of Linux assets for every core tag.

Control-release initialization, mirror activation, version selection, and
public asset writes require publication approval. Keep source repair, feed
restoration, and binary migration as separate outcomes. Migrating an original
legacy AppImage requires a separately approved greater-base release with
signed public assets and isolated upgrade/relaunch proof through the binary's
actual legacy endpoint and signing key. A new source endpoint or restored
manifest alone cannot supply that proof. Package-managed installs keep their
package-manager/download path; leave opt-in macOS/Windows Tauri test channels
unchanged.

### Missing canonical manifest

If replacement deletes `linux-stable/latest.json` and its upload is interrupted,
normal publication and mirroring must fail closed. `mirror` cannot recover a
missing canonical manifest. Do not reset the channel or infer a recovery target
from the newest release, release-body text, or a supplied version/hash.

Recovery requires explicit release-owner approval and one bounded, coordinated
operation:

1. Establish the last verified canonical version and exact bytes. Reconcile all
   intervening publication evidence, including failed or interrupted promotions,
   to establish the version floor using the existing release ordering contract.
   Missing or ambiguous history remains stopped; an immutable manifest's
   existence alone does not prove it was the authorized canonical version.
2. Agree on an exclusive recovery window with the Linux publication and core
   release owners. Record the operator and deadline, hold competing publish and
   mirror dispatches, and finish or explicitly resolve queued/running writers.
   Serialize the recovery with those publication writers; do not proceed until
   concurrent writes are excluded. This is owner coordination, not a new
   scheduler or a waiting job inside core's top-level concurrency.
3. Select and approve the exact immutable `OpenClaw-<version>-linux.json` bytes
   against that history and floor. Verify its digest, source/tooling/channel
   identities, versioned release ID, public asset inventory, and signed-bundle
   evidence. Do not regenerate its signature, `pub_date`, or JSON.
4. Freshly read the channel release ID, fixed tag SHA, and complete asset
   inventory. Confirm the approved identities and canonical absence immediately
   before one owner-controlled upload of the verified bytes as `latest.json`.
   If an asset appears, identities or inventory move, or the deadline expires,
   stop for reconciliation rather than overwrite or retry automatically.
5. Read the canonical manifest back publicly and compare its exact bytes.
   Recheck the channel identity and resulting inventory. Only after this passes,
   use the normal mirror path with fresh core tag/SHA, release ID, and actual
   latest-selector checks. Verify the public legacy endpoint against the same
   bytes and recheck its release identity; dispatch acceptance is not readback.
6. Retain the separate canonical and legacy outcomes before releasing the
   recovery window. A failed legacy readback remains visibly degraded even if
   canonical restoration succeeded; do not reset either endpoint to conceal it.

This procedure supplies no standing public-write authority and no automatic
recovery mode. Any further attempt needs fresh owner reconciliation.

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
