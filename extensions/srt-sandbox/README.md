# @openclaw/srt-sandbox

Official Docker-free local sandbox backend for OpenClaw, built on the Anthropic
Sandbox Runtime (SRT).

This plugin runs sandboxed tool execution directly on the Gateway host. macOS
uses Seatbelt; Linux uses Bubblewrap with the required seccomp helper. Windows
execution is disabled.

## Install

```bash
openclaw plugins install @openclaw/srt-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

Set `agents.defaults.sandbox.backend` to `"srt"`, enable
`plugins.entries.srt-sandbox`, and restart the OpenClaw Gateway. SRT settings
such as `network`, `allowedDomains` and `writablePaths` belong under
`plugins.entries.srt-sandbox.config`.

Platform support, network modes and workspace access rules:

- https://docs.openclaw.ai/plugins/reference/srt-sandbox

## Package

- Plugin id: `srt-sandbox`
- Package: `@openclaw/srt-sandbox`
- Minimum OpenClaw host: `2026.9.6`
