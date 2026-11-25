---
summary: "Compacts exec and bash tool results with tokenjuice reducers."
read_when:
  - You are installing, configuring, or auditing the tokenjuice plugin
title: "Tokenjuice plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Compacts exec and bash tool results with tokenjuice reducers.

## Distribution

- Package: `@openclaw/tokenjuice`
- Install route: npm or ClawHub: `@openclaw/tokenjuice`

## Surface

- Contracts: `agentToolResultMiddleware`

<!-- openclaw-plugin-reference:manual-start -->

## Compaction scope

Tokenjuice compacts OpenClaw `exec` and `bash` results in embedded runs and
OpenClaw dynamic tools in the Codex app-server harness. Native codex-rs shell
results returned to the model stay unchanged.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [Tokenjuice](/tools/tokenjuice)
