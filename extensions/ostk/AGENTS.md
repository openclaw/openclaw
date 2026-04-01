# ostk Backend Plugin

This plugin registers the ostk kernel as a CLI backend for OpenClaw.

## What it does

Replaces `claude -p` / `codex exec` / `gemini --prompt` subprocess spawns
with `ostk agent run` — kernel-managed sessions with compiled context,
session journals, and pin-enforced capabilities.

## Boundary rules

- This plugin only registers a `CliBackendPlugin`. It does not modify
  core agent behavior, system prompt building, or gateway routing.
- The `ostk` binary must be on PATH or configured via
  `agents.defaults.cliBackends.ostk.command`.
- Pin capabilities are managed by `.ostk/pins/`, not by this plugin.

## User configuration

```yaml
# Switch default backend
agents:
  defaults:
    provider: ostk

# Or per-agent
agents:
  myagent:
    provider: ostk
    model: claude-sonnet-4-5
```

## Files

- `cli-backend.ts` — CliBackendPlugin definition (command, args, session config)
- `index.ts` — plugin registration via `api.registerCliBackend()`
- `openclaw.plugin.json` — plugin manifest
- `package.json` — package metadata
