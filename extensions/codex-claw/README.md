# Codex Claw

Codex Claw is an OpenClaw code plugin that installs a local Codex Desktop
plugin payload for loading selected `AGENTS.md` and `SOUL.md` files into native
Codex Desktop sessions.

Use it when you want the native Codex Desktop app to inherit OpenClaw workspace
context, collaboration preferences, and personality notes without manually
copying private files into a separate plugin repository.

## What It Does

- Adds the `openclaw codex-claw` CLI command.
- Writes a local Codex Desktop marketplace payload under
  `~/.codex/openclaw-codex-claw-marketplace`.
- Writes `~/.codex/codex-claw.json` with explicit `agentsPath` and `soulPath`
  values.
- Loads the configured files through Codex Desktop hooks as lower-priority
  session bootstrap context.
- Supports post-compaction reinjection through a `UserPromptSubmit` hook that
  defaults to `after_compact`.
- Provides a compatibility review prompt for cleaning `AGENTS.md` and `SOUL.md`
  before using them as always-on Codex context.

Codex Claw does not copy your real `AGENTS.md` or `SOUL.md` into the generated
payload. The generated plugin reads the explicit local paths from
`~/.codex/codex-claw.json`.

## Install

```bash
openclaw plugins install clawhub:@openclaw/codex-claw
```

Then from your OpenClaw workspace:

```bash
openclaw codex-claw install \
  --agents ~/.openclaw/workspace/AGENTS.md \
  --soul ~/.openclaw/workspace/SOUL.md
```

Register the generated marketplace with Codex Desktop:

```bash
codex plugin marketplace add ~/.codex/openclaw-codex-claw-marketplace
```

If the `codex` binary is not on your `PATH` on macOS, use:

```bash
/Applications/Codex.app/Contents/Resources/codex plugin marketplace add ~/.codex/openclaw-codex-claw-marketplace
```

Make sure `~/.codex/config.toml` enables plugins and hooks:

```toml
[features]
plugins = true
codex_hooks = true
plugin_hooks = true

[plugins."codex-claw@codex-claw"]
enabled = true
```

Restart Codex Desktop after changing plugin settings.

## Commands

```bash
openclaw codex-claw install
openclaw codex-claw status
openclaw codex-claw review-prompt
```

`status` checks the generated marketplace payload, config file, and configured
source paths without reading private file contents.

`review-prompt` prints questions for finding instructions that conflict with
native Codex behavior, unavailable tools, safety boundaries, or normal
reliability reporting.

## Safety Model

The hook output explicitly tells Codex that native system, developer, safety,
tool, and direct user instructions take priority over loaded context files.

Before enabling full context, review both files for instructions that:

- claim higher priority than native Codex instructions
- require OpenClaw, Claude, Eva, gateway, ACP, voice, or memory tools without
  scoping those requirements
- ask the agent to hide uncertainty or pretend unavailable capabilities exist
- include secrets, credentials, private customer data, or memories that should
  not appear in every Codex Desktop session

