---
summary: "CLI reference for `openclaw completion` (generate/install shell completion scripts)"
read_when:
  - You want shell completions for zsh/bash/fish/PowerShell
  - You need to cache completion scripts under OpenClaw state
title: "Completion"
---

# `openclaw completion`

Generate shell completion scripts and optionally install them into your shell profile.

## Usage

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
openclaw completion --write-state
openclaw completion --shell bash --write-state
```

## Options

- `-s, --shell <shell>`: shell target (`zsh`, `bash`, `powershell`, `fish`; default: `zsh`)
- `-i, --install`: install completion by adding a source line to your shell profile
- `--write-state`: write completion script(s) to `$OPENCLAW_STATE_DIR/completions` without printing to stdout
- `-y, --yes`: skip install confirmation prompts

## Notes

- `--install` writes a small "OpenClaw Completion" block into your shell profile and points it at the cached script.
- Without `--install` or `--write-state`, the command prints the script to stdout.
- Completion generation eagerly loads command trees so nested subcommands are included.

## Environment

- `OPENCLAW_COMPLETION_CACHE_WRITE_TIMEOUT_MS`: spawn timeout (in milliseconds) for the `openclaw completion --write-state` subprocess invoked from `openclaw update` and `openclaw doctor completion`. Defaults to `30000`. Accepts only positive integer milliseconds in the safe-integer range; malformed values (e.g. `60_000`, `1e5`, `1.5`, leading zeros, hex prefixes) silently fall back to the default. Useful when raising the budget for slower targets (Pi-class hardware, throttled containers, low-end VPS) without source changes.

## Related

- [CLI reference](/cli)
