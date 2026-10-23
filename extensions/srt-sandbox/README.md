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

## macOS workflow qualification

On macOS 15.3.1 (arm64), installed OpenClaw 2026.10.3 with SRT 0.0.76
allowed shell pipelines, Node 26.5.0 itself, ripgrep, curl version queries, and
tar/gzip. Node child-process APIs failed with `EPERM`; npm 11.17.0 and pnpm
11.2.2 script execution failed, and the system Python 3.9 launcher failed at
`posix_spawn`. Git initialization with default templates also failed while
copying protected hooks. Status, diff, and an empty commit in an existing
repository without hooks succeeded. A make/cc build failed with `Operation not
permitted` when make launched the compiler. A version command succeeding does
not qualify that tool's build or subprocess workflows.

The mandatory custody restrictions cannot be disabled independently. This
qualification records the compatibility limits; macOS support acceptance remains
a maintainer decision. See the platform reference for the enforcement boundary.

## Package

- Plugin id: `srt-sandbox`
- Package: `@openclaw/srt-sandbox`
- Minimum OpenClaw host: `2026.10.3` (required by `openclaw.compat.pluginApi`)
