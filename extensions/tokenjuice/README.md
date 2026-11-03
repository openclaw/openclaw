# @openclaw/tokenjuice

Official Tokenjuice output compaction plugin for OpenClaw.

Tokenjuice compacts noisy OpenClaw `exec` and `bash` tool results in embedded runs and OpenClaw dynamic tools in the Codex app-server harness. Native codex-rs shell results returned to the model stay unchanged. It does not rewrite commands, rerun commands, or change exit codes.

## Install

```bash
openclaw plugins install @openclaw/tokenjuice
```

Restart the Gateway after installing or updating the plugin.

## Enable

```bash
openclaw config set plugins.entries.tokenjuice.enabled true
```

Equivalent:

```bash
openclaw plugins enable tokenjuice
```

## Docs

- https://docs.openclaw.ai/tools/tokenjuice

## Package

- Plugin id: `tokenjuice`
- Package: `@openclaw/tokenjuice`
- Minimum OpenClaw host: `2026.5.28`
