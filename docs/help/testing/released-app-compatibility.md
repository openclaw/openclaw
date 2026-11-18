---
summary: "Released mobile app compatibility with a candidate Gateway: required runtime proof and current blockers"
title: "Released app compatibility"
read_when:
  - Qualifying a candidate Gateway against released mobile apps
  - Selecting native app artifacts for reverse compatibility testing
---

## Status: not implemented

Released stable iOS and Android apps running against the candidate Gateway are
not currently covered by an automated runtime lane. This page records the
boundary that must be implemented; it is not a passing compatibility result.

The existing `scripts/ios-release-e2e.ts` and
`scripts/android-release-e2e.ts` build candidate-source apps and run them against
a published stable Gateway. They prove the opposite direction. Their native build
receipts, static protocol-event checks, and successful app-store upload jobs do
not establish released-app compatibility with a candidate Gateway.

## Select the app independently of the Gateway

A Gateway release and a mobile release do not necessarily have the same version,
source commit, publication date, or distribution channel. Select the current
public app through the existing store owners, then freeze that selection for the
whole run:

- Android: `android_play_state` in `apps/android/fastlane/Fastfile` queries
  `production` and `wear:production`. The Android release planner resolves
  public version codes through the existing mobile-release source refs. Its store
  query opens an edit and aborts it; it is not an upload or promotion.
- iOS: `ios_public_release_notes_baseline` in `apps/ios/fastlane/Fastfile`
  resolves the latest historically public App Store version and its selected
  build, including versions removed from sale. The existing
  `pnpm ios:release:plan -- --json` entry point includes that release-notes
  baseline, not proof of current availability. Before selecting it for runtime
  qualification, extend the existing store owner to verify current availability
  and the exact installed build. An unavailable build is a blocker, not a reason
  to substitute the next planned upload or another unverified build.

Reuse these owners rather than adding another interpretation of production
tracks, released App Store states, or mobile version numbering. Store reads need
the existing scoped credentials; an unavailable query is a setup blocker, not
permission to fall back to the newest CI artifact.

Record the public version/build, source SHA, artifact digest, signing identity,
and acquisition provenance separately from the candidate Gateway SHA. A
successful upload, a TestFlight build, an internal-track AAB, a Git tag, or a
locally rebuilt old source checkout is not by itself proof of a public stable app.

## Artifact and harness blockers

### Android

The store release owner retains signed AABs and checksums. An AAB is not an
installable APK. Generating and signing APKs locally from an AAB changes the
artifact being tested; it cannot silently count as the Play-installed app.
The existing store owner has no signed, Play-generated APK retrieval path.

The current Android E2E harness installs instrumented debug APKs with package
`ai.openclaw.app.debug`. Its tests read app-private files, use app classes, and
adapt Wear delivery through an in-process test transport. Those assumptions
cannot be applied to the production-signed app by swapping its path.

Unblock Android with a supported acquisition path for the exact public,
Play-signed APK set, including the installed split set where applicable, or a
task-owned device with the verified public app already installed. Use external
UI automation without rebuilding, resigning, injecting an instrumentation APK
into the production app, or enabling debug-only hooks. Keep Wear explicitly
uncovered until its released app and real phone/Wear delivery can be exercised.

### iOS

The store release owner retains device IPAs, not simulator app products. The
current iOS harness builds Debug simulator products and an XCTest runner, and
executes them with `test-without-building`. A retained device IPA is not a
replacement simulator product. A retained upload also does not prove that Apple
published that build.

Unblock iOS with an authorized physical iOS test device running the exact public
App Store build and an external UI automation route that preserves its identity.
Do not rebuild the old source for Simulator, resign the app, or distribute a new
TestFlight build and label it the released stable app. Pairing and relaunch proof
must run against the installed public binary.

### Desktop

Published desktop binaries exist, but neither mobile E2E owner runs them.
Desktop compatibility is not implied by mobile results. Keep it out of this lane
until an existing released-desktop runtime harness can be reused; do not add a
parallel desktop framework to unblock mobile proof.

## Proposed independent release child

The intended child is independent of candidate iOS/Android build jobs and of
normal CI's mobile-build selection. It must not require a candidate app build
artifact or the stable-Gateway preparation action.

Proposed dispatch inputs are `target_sha` (the full candidate Gateway commit)
and `dispatch_id` (the existing full-release child correlation value). Resolve
and freeze public app identities at child startup. Reuse the existing
full-release child evidence and manifest owners rather than creating a second
receipt protocol. This is an interface proposal, not an available workflow.

For the runtime implementation:

1. Verify the exact candidate source and prepare the candidate Gateway using the
   existing isolated Gateway test-instance owner. Keep its state, ports, provider
   fixtures, and cleanup task-owned; do not connect a test app to a live operator
   Gateway.
2. Acquire and verify the public apps as described above. Missing credentials,
   artifacts, supported devices, or automation produce an explicit blocked result.
3. Drive ordinary setup-code pairing through the released app UI. Send a unique
   chat marker, verify the reply in the app and the local provider request, then
   terminate/relaunch the app and verify saved pairing and chat history. Send a
   second marker after relaunch so cached UI cannot satisfy the proof.
4. Record each platform separately: selected app identity, candidate Gateway
   identity, actual pairing/chat/relaunch checkpoints, cleanup result, and named
   exclusions. Export only sanitized evidence; never setup codes or raw logs.
5. Admit the child as release compatibility evidence only after the selected
   platforms finish real runtime proof. An inventory-only run, a blocked platform,
   an upload receipt, a skip, or a schema-only check must not become success.

No child workflow is registered yet: adding an always-failing inventory job would
not implement this runtime boundary. Store artifact acquisition and the physical
iOS automation route remain prerequisites to implementation and proof.
