# ostk Backend Plugin

This plugin registers the ostk kernel as a CLI backend for OpenClaw.

## What it does

Replaces `claude -p` / `codex exec` / `gemini --prompt` subprocess spawns
with `ostk agent run` — kernel-managed sessions with compiled context,
session journals, and pin-enforced capabilities.

## Prerequisites

Install the ostk binary:

```bash
curl -fsSL https://ostk.ai/install.sh | sh
```

Or via Homebrew:

```bash
brew install os-tack/tap/ostk
```

Then initialize the kernel in your project:

```bash
cd your-project
ostk init
```

This creates `.ostk/` with compiled context, session state, and default pin
capabilities. See [ostk.ai](https://ostk.ai) for full documentation.

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
