---
summary: "Paste-ready GitHub release announcement draft for VeriClaw"
read_when:
  - Publishing the public GitHub release surface
  - Keeping GitHub and Apple-facing launch wording aligned
  - Writing the GitHub Releases page body
  - Preparing a launch post that mirrors the repository story
title: "GitHub Release Announcement"
---

# GitHub release announcement

Use this file as the default draft for the GitHub Releases page.

Current release posture:

- GitHub and App Store are being prepared toward the same ship point
- public copy should support both the repository launch surface and the Apple-native companion story
- release wording should not imply either side shipped earlier unless that is verified

## Release title options

- `VeriClaw: self-hosted AI assistant, MCP gateway, and correction workspace`
- `VeriClaw 爪印: evidence-first correction for a multi-agent bot runtime`
- `VeriClaw launch: self-hosted AI assistant with MCP gateway and runtime truth`

## Paste-ready GitHub release body

```md
# VeriClaw

VeriClaw is the public-facing product brand for a self-hosted AI assistant, MCP-compatible gateway, and multi-channel bot runtime for Discord, Telegram, WhatsApp, Slack, browser automation, and multi-agent workflows.

The current repository, runtime, Gateway, and CLI compatibility layer still use OpenClaw and `openclaw` naming under the hood.

VeriClaw 爪印 is built for the moment when a bot drifts, hallucinates, fake-completes, overreaches, or fails its professional role contract.

The ship story is:

- VeriClaw for the outward product story
- OpenClaw for runtime, channel orchestration, and tool-connected execution compatibility
- VeriClaw correction for evidence-first diagnosis, verification, and casebook learning

Instead of stopping at alerts or dashboards, the correction loop is:

- evidence
- diagnosis
- prescription
- verification
- casebook learning

## What this release adds

- a self-hosted AI assistant and MCP-compatible gateway story that is easy to deploy, fork, and extend
- a multi-channel runtime for Discord, Telegram, WhatsApp, Slack, and browser-driven workflows
- a correction-first native workspace instead of monitoring-only surfaces
- professional-role drift framing for named bots or seats
- a desktop hover companion that keeps supervision pressure visible
- case-based follow-up so every issue can move toward closure
- verification and casebook updates before a loop is considered closed

## Who this is for

- builders who want a self-hosted AI assistant they actually control
- teams running Discord bots, Telegram bots, WhatsApp bots, or Slack copilots
- operators who need one gateway for MCP tools, browser automation, and multi-agent routing
- developers who care about delivery integrity, anti-hallucination workflows, and runtime truth

## Why developers will fork this

- the runtime already spans channels, tools, and device surfaces
- the correction workflow turns vague bot failures into concrete evidence and next actions
- the repo is useful as both a production base and a reference implementation for AI gateway design
- the brand-plus-runtime split makes it easier to extend runtime and supervision separately

## Why this is different

The goal is not to be a generic dashboard, a VirusTotal-style scanner, or another trace viewer.

The goal is to combine:

- runtime execution
- channel delivery
- evidence-first correction
- verification before closure

So teams can answer three questions clearly:

1. What went wrong?
2. What should happen next?
3. Did the correction actually hold?

## Current launch scope

- GitHub repository launch plus App Store companion readiness converging toward the same ship point
- VeriClaw public launch story with OpenClaw runtime compatibility underneath
- watchOS remains outside the current release gate
- release copy should stay aligned across GitHub, docs, and Apple-facing materials

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
VeriClaw is the public-facing product brand for a self-hosted AI assistant and MCP-compatible gateway for multi-channel bots, browser automation, and multi-agent workflows.

The current runtime and CLI still use OpenClaw / `openclaw` naming under the hood.

VeriClaw 爪印 adds the correction layer for the moment a bot drifts. It pushes the workflow toward evidence, diagnosis, prescription, verification, and casebook learning.
```

## Social-share version

Use this when a repost or cross-post needs stronger fork intent:

```md
If you want a self-hosted AI assistant that can run Discord, Telegram, WhatsApp, Slack, MCP tools, browser automation, and multi-agent workflows from one gateway, that is the VeriClaw story.

If you also want runtime truth, evidence-first correction, and verification before calling work done, that is the VeriClaw correction layer.
```

## Maintainer notes

- Keep the wording `companion, not clone`.
- Keep `self-hosted AI assistant`, `MCP-compatible gateway`, `multi-channel bot runtime`, and `evidence-first correction` visible in most public launch copy.
- Do not claim watchOS is in the current release scope.
- Do not overstate market exclusivity.
- Do not describe GitHub or App Store as shipping earlier than the other unless that is verified.
- Keep the legal/IP pack linked anywhere the release body is substantially reused.
