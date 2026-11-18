---
summary: "Stable-release-source mobile client rebuilds against a candidate Gateway"
title: "Released app compatibility"
read_when:
  - Qualifying a candidate Gateway against stable mobile client source
  - Selecting native client inputs for release compatibility tests
---

# Released app compatibility

The **Stable Release Source Compatibility** workflow tests Android and iOS apps
rebuilt from a published stable repository release against a candidate Gateway.
This is **stable-release-source rebuild compatibility**, not a test of the current
public mobile store build or an exact store-distributed binary.

The normal mobile release E2E direction is unchanged: candidate client source
against a published stable Gateway. The compatibility workflow reverses that
relationship without building apps from candidate source.

## Frozen inputs and execution

Dispatch `stable-release-source-compatibility.yml` at the candidate commit with:

- `target_sha`: the full candidate Gateway and harness commit; it must match the
  workflow dispatch ref.
- `dispatch_id`: the caller's correlation ID.

The selector resolves GitHub's latest published stable repository release once,
then dereferences its tag to an immutable commit. Both platform jobs use that
same tag and SHA. A retained selection binds the client source to the candidate
and dispatch ID; reruns restore it rather than selecting a newer release.
Missing or expired rerun input fails and requires a new workflow run.

Each job keeps two separate checkouts:

- Candidate checkout: E2E harness, synthetic inference fixtures, isolated Gateway
  lifecycle, and built candidate Gateway. Its checkout and build identity must
  match `target_sha`.
- Stable checkout: native app and test sources, native generation, dependencies,
  and build products. Its clean source identity must match the selected release
  SHA. The harness does not copy candidate native sources into this checkout.

The existing iOS Simulator/XCTest and Android emulator/instrumentation harnesses
exercise pairing, chat, and relaunch persistence. They retain sanitized per-platform
proof, source identities, and failure status. Android Wear remains the existing
controlled test-transport boundary, not real phone-to-watch delivery proof.

The independent workflow is not yet an automatically dispatched or required
Full Release Validation child. Its selection artifact and platform proofs are
available for inspection; wiring release admission is separate from claiming a
successful native runtime run.

## What this does not prove

A repository release tag does not establish which mobile build is currently
public. Debug simulator/emulator rebuilds differ from store builds in signing,
entitlements, optimization, delivery splits, and platform services.

For public-mobile-source qualification, first resolve the public store build
through the existing Fastfile store-query owners, then its immutable
`refs/openclaw/mobile-releases/` source mapping. Uploaded refs alone do not prove
production availability. The iOS release-notes baseline includes historically
public versions removed from sale, so it is not current-availability proof.

Exact store-binary qualification additionally needs installable Play-signed
APKs/splits or an already provisioned device, and an authorized physical iOS
device with external automation. Retained Android AABs and TestFlight IPAs do not
satisfy those requirements. Those constraints do not block the source-rebuild
lane described here.

Local unit and workflow checks do not replace native runtime proof. Keep a change
in draft until the selected stable source has completed both platform jobs, or
report each remaining OS/toolchain/runtime gap explicitly.
