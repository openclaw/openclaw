---
title: "Exec target override bypass fix"
summary: "Hardened exec target resolution so auto defaults no longer allow model-requested host overrides."
author: "Codex <codex@openai.com>"
github_username: "codex"
created: "2026-03-29"
---

Investigated a high-severity regression in exec target resolution.

What changed:

- Confirmed current behavior allowed `configuredTarget=auto` with `requestedTarget=gateway/node`, which selects host execution even when sandbox is available.
- Restored fail-closed allowlist behavior by requiring requested target to exactly match configured target.
- Updated the runtime unit test to verify host overrides are rejected when configured target is `auto`.

Why:

- `auto` should choose runtime host automatically, not grant untrusted host-selection overrides.
