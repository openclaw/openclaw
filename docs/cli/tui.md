---
summary: "CLI reference for `openclaw tui` (terminal UI connected to the Gateway)"
read_when:
  - You want a terminal UI for the Gateway (remote-friendly)
  - You want to pass url/token/session from scripts
title: "tui"
---

# `openclaw tui`

Open the terminal UI connected to the Gateway.

Related:

- TUI guide: [TUI](/web/tui)

Notes:

- `tui` resolves configured gateway auth SecretRefs for token/password auth when possible (`env`/`file`/`exec` providers).
- When launched from inside a configured agent workspace directory, TUI auto-selects that agent for the session key default (unless `--session` is explicitly `agent:<id>:...`).

## Examples

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
# when run inside an agent workspace, infers that agent automatically
openclaw tui --session bugfix
openclaw tui --theme dracula
```

## Theme

Select a color theme with `--theme <name>` or set the `OPENCLAW_THEME` environment variable.

Available themes: `dark` (default), `light`, `dracula`, `catppuccin-mocha`, `solarized-dark`.

Auto-detection: when no theme is specified, the TUI reads the `COLORFGBG` environment variable to detect light vs dark terminals.

Switch at runtime with `/theme <name>` or `/theme` to open a picker.
