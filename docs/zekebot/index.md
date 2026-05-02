---
summary: "ZekeBot is the Zeke-governed OpenClaw fork for profile-bound agent runtimes."
read_when:
  - Understanding how ZekeBot differs from stock OpenClaw
  - Choosing whether a deployment should use a ZekeBot profile
title: "ZekeBot"
---

# ZekeBot

ZekeBot is the Zeke-governed fork of OpenClaw. It keeps the OpenClaw gateway, channels, sessions, and plugin model, then adds Zeke-specific image governance, native Zeke tools, and profile-bound tool catalogs.

Use ZekeBot when an agent should operate inside Zeke governance. That means ZekeFlow remains the authority for context policy, signal proposals, approvals, audit, and durable state even though the agent sees native OpenClaw tools.

## Platform shape

ZekeBot has three layers:

- OpenClaw runtime: gateway, channel, session, provider, and plugin machinery.
- ZekeBot fork layer: image publishing, profile templates, native Zeke plugin, and stock-equivalence smoke gates.
- ZekeFlow authority: tool execution, caller identity, approval state, context broker policy, and audit.

The fork is designed to stay close to upstream OpenClaw. Local differences are documented in [ZekeBot versus upstream OpenClaw](/zekebot-vs-upstream).

## Current profiles

| Profile         | Intended runtime                   | Internal Zeke tools           |
| --------------- | ---------------------------------- | ----------------------------- |
| Sprout          | Chief of Staff runtime             | Full initial native Zeke set. |
| Rambo internal  | Operational browser and QA runtime | Context tools only.           |
| External client | Future tenant baseline             | None by default.              |

Profile boundaries are part of the product contract. A tool is not available just because the plugin implements it; it must also be allowed by the active profile and accepted by ZekeFlow.
