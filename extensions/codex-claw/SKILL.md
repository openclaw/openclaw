---
name: codex-claw
description: Install, verify, or review Codex Claw, the OpenClaw code plugin that bridges AGENTS.md and SOUL.md into native Codex Desktop sessions.
---

# Codex Claw

Codex Claw is an OpenClaw code plugin. It adds the
`openclaw codex-claw` command group for installing and checking a local Codex
Desktop plugin payload.

Use this when a user wants native Codex Desktop sessions to load selected
OpenClaw `AGENTS.md` and `SOUL.md` files as lower-priority session context.

## Commands

Install the bridge payload:

```bash
openclaw codex-claw install \
  --agents ~/.openclaw/workspace/AGENTS.md \
  --soul ~/.openclaw/workspace/SOUL.md
```

Inspect the local bridge state without reading private file contents:

```bash
openclaw codex-claw status
```

Print compatibility cleanup questions:

```bash
openclaw codex-claw review-prompt
```

## What The Bridge Writes

`install` writes a Codex Desktop marketplace payload under
`~/.codex/openclaw-codex-claw-marketplace` and writes
`~/.codex/codex-claw.json` with explicit `agentsPath`, `soulPath`, `mode`, and
`userPromptReinject` settings.

It does not copy the real `AGENTS.md` or `SOUL.md` files into the package.
Codex Desktop hooks read the configured local paths at session time.

## Codex Desktop Setup

After install, register the generated marketplace:

```bash
codex plugin marketplace add ~/.codex/openclaw-codex-claw-marketplace
```

Enable plugins and hooks in `~/.codex/config.toml`:

```toml
[features]
plugins = true
codex_hooks = true
plugin_hooks = true

[plugins."codex-claw@codex-claw"]
enabled = true
```

Restart Codex Desktop after changing plugin settings.

## Safety Review

Before making `AGENTS.md` and `SOUL.md` always-on context, remove or scope
instructions that claim higher priority than native Codex instructions, require
unavailable tools, hide uncertainty, suppress failed tests, or include secrets.

