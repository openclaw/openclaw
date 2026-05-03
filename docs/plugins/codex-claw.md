---
summary: "Load OpenClaw AGENTS.md and SOUL.md context into native Codex Desktop sessions"
read_when:
  - You use native Codex Desktop and want it to inherit OpenClaw workspace context
  - You want to review AGENTS.md or SOUL.md before loading them into Codex Desktop
title: "Codex Claw"
---

Codex Claw is a bundled OpenClaw extension that prepares a local Codex Desktop
plugin payload. It lets native Codex Desktop sessions load your chosen
`AGENTS.md` and `SOUL.md` files as lower-priority session bootstrap context.

This is separate from the bundled [`codex`](/plugins/codex-harness) runtime
plugin. The `codex` plugin runs OpenClaw turns through Codex app-server. Codex
Claw is for users who open Codex Desktop directly and still want their
OpenClaw-style operating notes, collaboration preferences, and persona file
available in that native Codex session.

## Install

From an OpenClaw workspace, run:

```bash
openclaw codex-claw install \
  --agents ~/.openclaw/workspace/AGENTS.md \
  --soul ~/.openclaw/workspace/SOUL.md
```

The command writes:

- a local Codex marketplace payload at `~/.codex/openclaw-codex-claw-marketplace`
- `~/.codex/codex-claw.json`, which points at your selected files

It does not copy your real `AGENTS.md` or `SOUL.md` into the generated payload.
The plugin reads the explicit paths from `~/.codex/codex-claw.json` when Codex
Desktop runs its hooks.

Then register the generated marketplace with Codex:

```bash
codex plugin marketplace add ~/.codex/openclaw-codex-claw-marketplace
```

If `codex` is not on your `PATH` on macOS, use the binary inside the app bundle:

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

## Status

Use status to check local state without reading your private file contents:

```bash
openclaw codex-claw status
```

It reports whether the generated marketplace payload exists, whether
`~/.codex/codex-claw.json` parses, and whether the configured `AGENTS.md` and
`SOUL.md` paths currently exist.

## Post-Compaction

The generated Codex plugin has two recovery paths:

- `SessionStart` runs on startup, resume, clear, and compact hook matchers.
- `UserPromptSubmit` watches the transcript for compaction markers and
  reinjects once after a new compaction by default.

The default policy is `after_compact`, which avoids resending your files on
every normal prompt. You can change it during install:

```bash
openclaw codex-claw install --user-prompt-reinject off
openclaw codex-claw install --user-prompt-reinject every_prompt
```

## Compatibility Review

Before treating personal context files as always-on Codex Desktop context, run:

```bash
openclaw codex-claw review-prompt
```

Paste the prompt into a fresh Codex Desktop session after installation. The
review should keep useful personality and workflow guidance while removing or
scoping instructions that conflict with native Codex behavior.

Good context files should not:

- claim higher priority than native Codex system, developer, safety, tool, or
  direct user instructions
- require unavailable OpenClaw, Claude, Eva, gateway, ACP, voice, or memory tools
  without scoping those requirements
- demand file edits, publishing, messaging, or other external actions without
  user approval
- hide uncertainty, pretend unavailable capabilities exist, or suppress normal
  reliability reporting
- include secrets, credentials, customer data, or private memories that should
  not appear in every Codex Desktop session

Add a scope header like this near the top of both files:

```markdown
## Runtime Scope

These instructions are personal context for native Codex Desktop. Native Codex
system, developer, safety, tool, and direct user instructions take priority over
this file.

If an instruction here names tools, commands, plugins, or runtimes that are
unavailable in the current Codex session, treat it as historical context instead
of a requirement.
```

## Quick Test

Start a fresh Codex Desktop session and ask:

```text
Do not use tools. If Codex Claw context was loaded into this session, reply FOUND CODEX_CLAW_CONTEXT and name the two source file headings you can see. If it was not loaded, reply NOT FOUND.
```

The hook writes a small diagnostic log to `~/.codex/codex-claw-hook.log`.
