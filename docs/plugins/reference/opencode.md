---
summary: "Adds OpenCode model provider support to OpenClaw."
read_when:
  - You are installing, configuring, or auditing the opencode plugin
title: "OpenCode plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Adds OpenCode model provider support to OpenClaw.

## Distribution

- Package: `@openclaw/opencode-provider`
- Install route: npm or ClawHub: `clawhub:@openclaw/opencode-provider`

## Surface

- Providers: `opencode`
- Contracts: `mediaUnderstandingProviders`

<!-- openclaw-plugin-reference:manual-start -->

## Native sessions

OpenClaw auto-detects the `opencode` CLI on the Gateway and paired nodes. Stored
sessions then appear in the **OpenCode** sessions-sidebar group, with transcript
browsing through the official CLI. OpenCode v1 uses `--pure db` and `--pure export`;
v2 uses `api session.list` and `session export` with a private standalone server.
Local rows also offer **Continue**, which
creates an OpenClaw session whose first turn resumes the native OpenCode session
through ACP. OpenCode retains the full server-side model context, and the catalog
viewer continues to show that history. OpenClaw also imports the recent native
history into the adopted session transcript. Very long transcripts import only
their most recent 200 items using a 512 KiB serialized-item budget. Paired-node
rows remain view-only.

The restricted environment prevents catalog browsing from inheriting unrelated
Gateway credentials. OpenCode v1 uses `--pure`; v2 uses an empty temporary config
directory with project configuration disabled to avoid loading user plugins.
Failed CLI calls produce an `opencode/session-catalog` warning in Gateway logs.

Turn **OpenCode Session Catalog** off under **Config > Plugins > OpenCode** to
disable discovery. It is enabled by default.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [opencode](/providers/opencode)
