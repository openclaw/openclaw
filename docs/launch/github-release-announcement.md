---
summary: "Paste-ready GitHub release announcement draft for VeriClaw"
read_when:
  - Publishing the GitHub-first public release
  - Writing the GitHub Releases page body
  - Preparing a launch post that mirrors the repository story
title: "GitHub Release Announcement"
---

# GitHub release announcement

Use this file as the default draft for the GitHub Releases page.

Current release posture:

- GitHub is the first public launch surface
- Apple companion release work continues in parallel
- release wording should not imply the App Store path is already public

## Release title options

- `VeriClaw 爪印: Apple-native correction companion for OpenClaw`
- `Introducing VeriClaw 爪印 for OpenClaw`
- `VeriClaw 爪印: correction-first supervision for OpenClaw`

## Paste-ready GitHub release body

```md
# VeriClaw 爪印

VeriClaw 爪印 is the Apple-native correction companion for OpenClaw.

OpenClaw remains the runtime and gateway. VeriClaw adds the native supervision
layer for the moments when a bot is drifting, hallucinating, overreaching, or
failing its professional role contract.

Instead of stopping at alerts, the core loop is:

- evidence
- diagnosis
- prescription
- verification
- casebook learning

## What this release adds

- a correction-first native workspace instead of monitoring-only surfaces
- professional-role drift framing for named bots or seats
- a desktop hover companion that keeps supervision pressure visible
- case-based follow-up so every issue can move toward closure
- verification and casebook updates before a loop is considered closed

## Why this is different

The goal is not to replace OpenClaw or generic observability tooling.

The goal is to give OpenClaw a native correction companion that answers three
questions clearly:

1. What went wrong?
2. What should happen next?
3. Did the correction actually hold?

## Current launch scope

- GitHub-first public release path
- OpenClaw runtime plus VeriClaw companion story
- Apple companion submission path continues in parallel
- watchOS remains outside the current release gate

## Legal and redistribution

Redistribution should preserve license, notice, attribution, and source
reference expectations.

See:

- LICENSE
- NOTICE
- ATTRIBUTION.md
- TRADEMARKS.md
- PATENTS.md
- INFRINGEMENT.md
```

## Short announcement version

Use this when a shorter GitHub post or pinned discussion is needed:

```md
VeriClaw 爪印 is the Apple-native correction companion for OpenClaw.

It is built for the moment when a bot drifts. Instead of stopping at monitoring,
it pushes the workflow toward evidence, diagnosis, prescription, verification,
and casebook learning.

OpenClaw remains the runtime. VeriClaw adds the native supervision layer.
```

## Maintainer notes

- Keep the wording `companion, not clone`.
- Do not claim watchOS is in the current release scope.
- Do not overstate market exclusivity.
- Keep the legal/IP pack linked anywhere the release body is substantially reused.
