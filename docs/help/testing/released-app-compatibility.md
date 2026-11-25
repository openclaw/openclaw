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

Dispatch `stable-release-source-compatibility.yml` at the reviewed qualification
commit with:

- `target_sha`: the full candidate Gateway commit. The dispatch ref pins the
  qualification harness and may differ from the candidate.
- `dispatch_id`: the caller's correlation ID.

The selector resolves GitHub's latest published stable repository release once,
then dereferences its tag to an immutable commit. Both platform jobs use that
same tag and SHA. A retained selection binds the client source to the candidate
and dispatch ID; reruns restore it rather than selecting a newer release.
Missing or expired rerun input fails and requires a new workflow run.
Before installing dependencies, each native job verifies that the frozen tag is
still a published stable release in the canonical repository and resolves to the
selected SHA. A changed tag fails rather than silently selecting newer source.
The checked-out client HEAD must match that verified SHA before its dependencies
are executed.

Each job separates these source identities:

- Qualification checkout: reviewed E2E harness, synthetic inference fixtures, and
  isolated Gateway lifecycle, pinned to the workflow commit.
- Candidate checkout: built Gateway whose checkout and build identity match
  `target_sha`. When candidate and qualification commits match, they share the
  same checkout; otherwise the candidate is checked out and built separately.
- Stable checkout: native app and test sources, native generation, dependencies,
  and build products. Its clean source identity must match the selected release
  SHA. The harness does not copy candidate native sources into this checkout.

The existing iOS Simulator/XCTest and Android emulator/instrumentation harnesses
exercise pairing, chat, and relaunch persistence. They retain sanitized per-platform
proof, source identities, and failure status. Android Wear remains the existing
controlled test-transport boundary, not real phone-to-watch delivery proof.

Full Release Validation dispatches this independent child for `all` and `ci`
groups, including the beta profile. It is separate from candidate app build
qualification: both stable-source native jobs must pass the compatibility gate.
The existing child receipt, execution plan, decision, and diagnostic drain retain
its exact run and terminal result. The selection artifact and per-platform proofs
retain the client tag/SHA and candidate identity. Missing, skipped, or failed
platforms do not qualify compatibility.

## Candidate execution boundary

Candidate dependency installation, builds, Gateway runtime, and CLI calls execute
inside the platform isolation owner; qualification evidence and provider fixtures
remain outside it. Linux uses a nonroot Docker container with a private volume
and restricted network. Its host-loopback published port forwards through a
fixed-destination relay to the Gateway’s container-loopback socket. This preserves
local backend authentication semantics without broadening Gateway authorization.
The relay shares the candidate container’s lifecycle and cannot select arbitrary
upstream destinations.

macOS uses a separate unprivileged user with a default-deny Seatbelt profile and
a public-only build dependency proxy. Runtime does not inherit build proxy
access. Seatbelt is supplemental isolation, not a claim that Apple supports
`sandbox-exec` as a general-purpose sandbox API. Both platforms must pass the
production hostile-source probe and the actual native flows.

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
