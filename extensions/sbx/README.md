# @openclaw/sbx-sandbox

Official Docker Sandboxes (`sbx`) sandbox backend for OpenClaw.

This plugin lets OpenClaw run agent tools inside Docker Sandboxes managed by the
`sbx` CLI, with the host workspace bind-mounted into the sandbox and command
execution through `sbx exec`.

## Install

```bash
openclaw plugins install @openclaw/sbx-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

Use the Docker Sandboxes docs for installation, workspace mounting, runtime
selection, and troubleshooting:

- https://docs.openclaw.ai/gateway/sbx

## Package

- Plugin id: `sbx`
- Package: `@openclaw/sbx-sandbox`
- Minimum OpenClaw host: `2026.5.12-beta.1`
