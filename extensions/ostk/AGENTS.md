# ostk Backend Plugin

This plugin registers the ostk kernel as a CLI backend for OpenClaw.

## What it does

Runs agent sessions through `ostk run <Agentfile>` — kernel-managed sessions
with compiled context, session journals, and pin-enforced capabilities.

## Prerequisites

Install the ostk binary:

```bash
curl -fsSL https://ostk.ai/install.sh | sh
```

The install script ([source](https://github.com/os-tack/ostk.ai/blob/main/install.sh))
downloads a platform-specific tarball from GitHub Releases, verifies the GPG
signature, and installs a single static binary to `/usr/local/bin/ostk`.

Then initialize the kernel in your project:

```bash
cd your-project
ostk init
```

This creates `.ostk/` with compiled context, session state, and default pin
capabilities. See [ostk.ai](https://ostk.ai) for full documentation.

## Bundled Agentfiles

Ready-to-use agent definitions for each supported model provider:

| File | Model | Run command |
|---|---|---|
| `agents/claude.Agentfile` | `claude-sonnet-4-5` | `ostk run extensions/ostk/agents/claude.Agentfile` |
| `agents/codex.Agentfile` | `o4-mini` | `ostk run extensions/ostk/agents/codex.Agentfile` |
| `agents/gemini.Agentfile` | `gemini-2.5-pro` | `ostk run extensions/ostk/agents/gemini.Agentfile` |

Each Agentfile grants `shell`, `file:read`, and `file:edit` tools under the
`default` pin. Customize by copying to your project root and editing.

## Boundary rules

- This plugin only registers a `CliBackendPlugin`. It does not modify
  core agent behavior, system prompt building, or gateway routing.
- The `ostk` binary must be on PATH or configured via
  `agents.defaults.cliBackends.ostk.command`.
- Pin capabilities are managed by `.ostk/pins/`, not by this plugin.

## User configuration

The ostk plugin is enabled by default — no manual plugin enable step is needed.
Just ensure the `ostk` binary is installed and on PATH, then select it as your
backend:

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

- `cli-backend.ts` — CliBackendPlugin definition (`ostk run Agentfile`)
- `index.ts` — plugin registration via `api.registerCliBackend()`
- `openclaw.plugin.json` — plugin manifest
- `package.json` — package metadata
- `agents/claude.Agentfile` — default Claude agent
- `agents/codex.Agentfile` — default Codex agent
- `agents/gemini.Agentfile` — default Gemini agent
