---
summary: "Opt-in Sparkle delta artifact generation and native verification gates"
read_when:
  - Prototyping smaller macOS app updates
  - Testing Sparkle delta artifacts before release publication
title: "Experimental macOS delta updates"
---

# Experimental macOS delta updates

The macOS app already uses Sparkle. This experiment reuses its delta generator,
archive signatures, updater, and installer. It does not introduce another patch
format or installer into OpenClaw. The pinned dependency is Sparkle 2.10.1 in
`apps/macos/Package.resolved`.

**Opt-in means release-time artifact generation, not a new app preference.**
Normal `make_appcast.sh` invocations and production feeds are unchanged. A tester
must deliberately build against a separate feed using the existing
`SPARKLE_FEED_URL` packaging override. Do not publish experimental enclosures to
the production feed: clients using that feed can automatically select them.

## Generate isolated artifacts

On a Mac with the pinned Sparkle tooling, choose the previous and current signed
ZIPs for the **same architecture, channel, and minimum-OS branch**. Use a test
signing key trusted by the test app, not production credentials. Keep the old
archive immutable: Sparkle needs the actual shipped app, including its signatures
and bundled runtime, rather than a rebuild of the same source version.

```sh
export SPARKLE_PRIVATE_KEY_FILE=/path/to/test-ed25519-key
export SPARKLE_GENERATE_APPCAST=/path/to/Sparkle/bin/generate_appcast
export SPARKLE_RELEASE_VERSION=2026.11.1
export SPARKLE_DOWNLOAD_URL_PREFIX=https://updates.example.invalid/delta-test/

/bin/bash scripts/make_appcast.sh \
  /path/to/OpenClaw-2026.11.1-arm64.zip \
  https://updates.example.invalid/delta-test/appcast.xml \
  --delta-from /path/to/OpenClaw-2026.10.10-arm64.zip \
  --output-dir /path/to/new-experiment-directory
```

Replace the example endpoint with an isolated test server when running the native
gate. This command does not upload anything. It:

- stages one previous archive alongside the target;
- asks Sparkle for at most one delta and one version per branch;
- leaves the checked-in production appcast untouched;
- exports the target ZIP, release notes, appcast, and referenced delta, if any;
- requires a signed full enclosure and signed delta enclosures whose URLs and
  lengths match the exported artifacts;
- refuses an existing output directory or a multi-branch experimental feed.

These export checks verify metadata consistency, **not cryptographic signatures**.
Sparkle's generator signs artifacts; the receiving native updater remains the
signature-verification authority. The feed is copied last, but no crash-atomic
publication protocol is claimed. Publish only a completed, independently verified
artifact directory through the existing release owner.

If Sparkle decides a delta is unsuitable or not small enough, the command can
succeed with zero deltas and reports that intentional full-download result. The
full archive remains available. Missing, unsigned, or inconsistent advertised
delta artifacts fail export rather than leaving a broken feed. No old full ZIP
is exported solely because it was used as a generation baseline.

## What has been proved

The shell-entrypoint tests exercise isolated export, retained full downloads,
unchanged legacy generation, invalid delta metadata, and non-overwrite behavior
using a generator fixture. They do **not** run Apple's signing tools, generate a
real Sparkle patch, launch OpenClaw, or install an update.

A separate portable zstd archive experiment reconstructed a real arm64 release
byte-for-byte. Its transfer and performance numbers are **not Sparkle results**
and cannot establish native updater behavior. See the separate archive-delta
benchmark report when available.

No native end-to-end result is recorded yet. Development ran on Linux without a
connected Mac. Keep this feature experimental until the following gate passes.

## Required native gate

Use an isolated Mac test account/VM and the
[native test safety rules](/platforms/mac/dev-setup#run-native-tests-safely).
Do not replace an operator's installed app, preferences, Gateway state, or keys.
Debug bundles intentionally disable Sparkle; use an isolated, signed test build
with the updater enabled and the test feed/public key embedded before signing.

Record the baseline and target versions, architecture, minimum OS, Sparkle
version, archive SHA-256 values, full and delta bytes, generation/application
wall times, peak memory, and actual HTTP transfer totals. Preserve the signed
ZIPs and generated feed with the result. Then:

1. Generate the feed with the command above. If no delta is emitted, report
   full-only delivery, not delta success.
2. Extract both ZIPs with `ditto`, apply the emitted patch with Sparkle's
   `BinaryDelta apply OLD.app RECONSTRUCTED.app PATCH.delta`, compare the
   reconstructed bundle's contents with the target, and verify its code signature
   with `codesign --verify --deep --strict`. This is artifact proof, not an
   installed-app test.
3. Launch the baseline OpenClaw test build, check for updates through its normal
   updater, accept the update, and confirm the target launches and connects to
   the isolated Gateway. Record that the delta, rather than the full ZIP, was
   actually requested.
4. Repeat with the delta returning HTTP 404 and with a patch that cannot apply.
   Confirm the full ZIP is fetched and installed. Repeat from a version with no
   matching delta: it must use the full download.
5. Tamper with the delta and separately with the full archive. Confirm no
   unauthenticated or invalid bundle is installed. Observe whether Sparkle
   refuses the update or falls back; do not call a rejection a successful update.
6. Interrupt download/application in the disposable environment. Confirm the
   old app remains usable or the existing installer recovers, then retry. Test
   retained full artifacts with the oldest supported client as well.

The pinned Sparkle source contains full-download fallback for delta download and
application failures in `Sparkle/SPUCoreBasedUpdateDriver.m`. Signature checks live
in `Sparkle/SUUpdateValidator.m`; patch application validates its expected trees
in `Autoupdate/SUBinaryDeltaApply.m`. These are source contracts, not substitutes
for the native gate above. Source: [Sparkle pinned revision](https://github.com/sparkle-project/Sparkle/tree/ab7d71291238df6e0492143b120c9b696a35f603).

## Compatibility, rollback, and scope

Keep the full signed ZIP and current feed semantics for old clients, skipped
versions, unavailable bases, and unsuitable patches. Do not manually force a
new delta format; let the pinned generator account for the baseline's Sparkle
version. Never strip or re-sign baseline bundles to improve a benchmark.

This change does not add post-launch health rollback or alter Gateway state
migration/rollback. Retaining a previous app artifact is not proof that a newer
Gateway database can safely be downgraded. Preserve the existing app installer
and Gateway update contracts; test interrupted installation separately.

Linux AppImage is a possible later prototype: reconstruct the existing signed
AppImage and retain its current verification/installation owner. Linux deb/rpm
remain package-manager-owned. Windows Tauri and the separately maintained
Windows Hub need distinct carrier investigations. Leave App Store/Play delivery,
CLI/Gateway activation, and Swabble outside this macOS experiment.
